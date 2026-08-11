// Package extension implements Torch's Flare Compute Extension.
//
// One operation: ATTEST_FILL. Given a vault position id and the Hyperliquid
// order id the vault recorded for it, the enclave queries Hyperliquid itself
// and reports what actually filled. The caller supplies no prices — it can
// only ask a question, never answer one.
//
// Why this belongs in a TEE rather than in the agent: today Torch's operator
// reports the fill price and the vault checks it against FTSOv2's band. That
// band is real protection, but inside it the operator still chooses. Here the
// number comes from attested code that fetched the exchange directly, and a
// Torch contract verifies the enclave's signature before accepting it.
//
// It is deliberately narrow. Liquidations and stop-losses stay on the polling
// agent: an extension only runs when an on-chain instruction reaches it via
// data-provider consensus, and "this position just became liquidatable" emits
// no event for anyone to hang an instruction off.
package extension

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"extension-scaffold/internal/config"
	"extension-scaffold/pkg/types"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
	"github.com/flare-foundation/tee-node/pkg/processorutils"
)

// The account whose fills back Torch positions. Pinned here and in
// TorchFdcConsumer.sol so the enclave cannot be pointed at a different book.
const hlAccount = "0xfDb941fe97e13B599BC576c4142128aB97D01622"

// The vault TorchTeeExecutor guards, and the chain it lives on. Both are
// folded into the signed digest so a signature produced here cannot be
// replayed against another deployment.
const (
	torchChainID = 114
	torchVault   = "0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd"
	digestTag    = "TORCH_ATTEST_FILL"
)

// fillDigest mirrors TorchTeeExecutor.fillDigest exactly:
//   keccak256(abi.encode(chainid, vault, "TORCH_ATTEST_FILL", id, price6, oid))
// abi.encode pads every head element to 32 bytes; the string is dynamic, so it
// is an offset here and its length+bytes at the tail.
func fillDigest(positionID, entryPrice6, oid *big.Int) []byte {
	word := func(b *big.Int) []byte {
		out := make([]byte, 32)
		b.FillBytes(out)
		return out
	}
	tag := []byte(digestTag)
	var buf []byte
	buf = append(buf, word(big.NewInt(torchChainID))...)
	buf = append(buf, word(new(big.Int).SetBytes(common.HexToAddress(torchVault).Bytes()))...)
	buf = append(buf, word(big.NewInt(6*32))...) // offset to the string tail
	buf = append(buf, word(positionID)...)
	buf = append(buf, word(entryPrice6)...)
	buf = append(buf, word(oid)...)
	buf = append(buf, word(big.NewInt(int64(len(tag))))...)
	padded := make([]byte, 32)
	copy(padded, tag)
	buf = append(buf, padded...)
	return crypto.Keccak256(buf)
}

// signViaNode asks the TEE node to sign a digest with the enclave key.
func signViaNode(signPort int, message []byte) ([]byte, error) {
	url := fmt.Sprintf("http://localhost:%d/sign", signPort)
	body, _ := json.Marshal(teetypes.SignRequest{Message: message})
	resp, err := http.DefaultClient.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("sign request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("node returned %d: %s", resp.StatusCode, string(b))
	}
	var sr teetypes.SignResponse
	if err := json.NewDecoder(resp.Body).Decode(&sr); err != nil {
		return nil, fmt.Errorf("decode sign response: %w", err)
	}
	return sr.Signature, nil
}

func hlAPI() string {
	if v := os.Getenv("HL_API_URL"); v != "" {
		return v
	}
	return "https://api.hyperliquid-testnet.xyz"
}

type Extension struct {
	mu     sync.RWMutex
	Server *http.Server

	// signPort is the TEE node's signing endpoint. The enclave key never
	// leaves the node; we hand it a digest and get a signature back.
	signPort int

	// Warm view of the account's fills, refreshed in the background. The TEE
	// node gives a handler only a few seconds to answer, and Hyperliquid's
	// userFills round trip takes ~4s from inside the enclave — too close to
	// the deadline to do synchronously. Refreshing off the request path means
	// an instruction is answered from memory, in microseconds.
	fills       map[uint64]hlFill
	fillsAt     time.Time
	refreshErr  string

	attestedCount int
	notFoundCount int
	lastOid       uint64
	lastCoin      string
	lastPx        string
}

// --- DO NOT MODIFY: New(), actionHandler() are boilerplate.
func New(extensionPort, signPort int) *Extension {
	e := &Extension{fills: map[uint64]hlFill{}, signPort: signPort}
	go e.refreshLoop()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)
	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}
	return e
}

func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	stateResponse := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State: types.State{
			AttestedCount: e.attestedCount,
			LastOid:       e.lastOid,
			LastCoin:      e.lastCoin,
			LastPx:        e.lastPx,
			NotFoundCount: e.notFoundCount,
		},
	}
	e.mu.RUnlock()
	if err := json.NewEncoder(w).Encode(stateResponse); err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
		return
	}
}

func (e *Extension) processAction(action teetypes.Action) (int, []byte) {
	dataFixed, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}
	switch {
	case dataFixed.OPType == teeutils.ToHash(config.OPTypeTorch):
		return e.processTorch(action, dataFixed)
	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			dataFixed.OPType.Hex(), teeutils.ToHash(config.OPTypeTorch).Hex(), config.OPTypeTorch,
		))
	}
}

func (e *Extension) processTorch(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandAttestFill):
		ar := e.processAttestFill(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b
	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected %s (%s)",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandAttestFill).Hex(), config.OPCommandAttestFill,
		))
	}
}

// hlFill is one entry of Hyperliquid's userFills response. Only the fields we
// report are decoded; the rest of the payload is ignored.
type hlFill struct {
	Coin string `json:"coin"`
	Dir  string `json:"dir"`
	Px   string `json:"px"`
	Sz   string `json:"sz"`
	Oid  uint64 `json:"oid"`
	Time uint64 `json:"time"`
}

// fetchAllFills asks Hyperliquid for the account's fills. Runs inside the
// enclave, so the operator never sees or shapes the answer.
func fetchAllFills() (map[uint64]hlFill, error) {
	body, err := json.Marshal(map[string]string{"type": "userFills", "user": hlAccount})
	if err != nil {
		return nil, fmt.Errorf("encoding request: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, hlAPI()+"/info", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 20 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("calling exchange: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("exchange returned HTTP %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("reading response: %w", err)
	}
	var fills []hlFill
	if err := json.Unmarshal(raw, &fills); err != nil {
		return nil, fmt.Errorf("decoding fills: %w", err)
	}
	out := make(map[uint64]hlFill, len(fills))
	for i := range fills {
		out[fills[i].Oid] = fills[i]
	}
	return out, nil
}

// priceTo6dp converts Hyperliquid's decimal string ("64863.0") into the
// vault's 6-decimal fixed point, without floats.
func priceTo6dp(px string) (*big.Int, bool) {
	whole, frac, _ := strings.Cut(px, ".")
	if len(frac) > 6 {
		frac = frac[:6]
	}
	for len(frac) < 6 {
		frac += "0"
	}
	v, ok := new(big.Int).SetString(whole+frac, 10)
	return v, ok
}

// refreshLoop keeps the fill cache warm. First pass runs immediately so the
// enclave is useful as soon as it boots.
func (e *Extension) refreshLoop() {
	for {
		fills, err := fetchAllFills()
		e.mu.Lock()
		if err != nil {
			e.refreshErr = err.Error()
		} else {
			e.fills, e.fillsAt, e.refreshErr = fills, time.Now(), ""
		}
		e.mu.Unlock()
		time.Sleep(20 * time.Second)
	}
}

// lookup answers from the warm cache. Returns (fill, known) where known is
// false only when we have never successfully reached the exchange.
func (e *Extension) lookup(oid uint64) (hlFill, bool, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.fillsAt.IsZero() {
		return hlFill{}, false, false // no view yet
	}
	f, ok := e.fills[oid]
	return f, ok, true
}

// processAttestFill: decode, validate, execute, respond.
func (e *Extension) processAttestFill(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var req types.AttestFillRequest
	dec := json.NewDecoder(bytes.NewReader(df.OriginalMessage))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
	}
	if req.Oid == 0 {
		// oid 0 is Torch's marker for a fill that never reached a venue (XRP
		// has no testnet book), so there is nothing on an exchange to attest.
		return buildResult(action, df, nil, 0, fmt.Errorf("oid must not be zero"))
	}

	fill, found, haveView := e.lookup(req.Oid)
	if !haveView {
		e.mu.RLock()
		why := e.refreshErr
		e.mu.RUnlock()
		if why == "" {
			why = "exchange view not warm yet"
		}
		return buildResult(action, df, nil, 0, fmt.Errorf("cannot reach exchange: %s", why))
	}

	resp := types.AttestFillResponse{PositionID: req.PositionID, Oid: req.Oid}
	if !found {
		e.mu.Lock()
		e.notFoundCount++
		e.mu.Unlock()
		resp.Found = false
	} else {
		resp.Found = true
		resp.Coin, resp.Side, resp.Px, resp.Sz, resp.Time = fill.Coin, fill.Dir, fill.Px, fill.Sz, fill.Time
		e.mu.Lock()
		e.attestedCount++
		e.lastOid, e.lastCoin, e.lastPx = fill.Oid, fill.Coin, fill.Px
		e.mu.Unlock()
	}

	// Sign the exact digest TorchTeeExecutor.confirmFillAttested verifies, so
	// the vault can be gated on this answer rather than on our word for it.
	if resp.Found {
		px6, ok := priceTo6dp(resp.Px)
		if !ok {
			return buildResult(action, df, nil, 0, fmt.Errorf("unparsable price %q", resp.Px))
		}
		digest := fillDigest(
			new(big.Int).SetUint64(req.PositionID),
			px6,
			new(big.Int).SetUint64(req.Oid),
		)
		sig, err := signViaNode(e.signPort, digest)
		if err != nil {
			return buildResult(action, df, nil, 0, fmt.Errorf("signing digest: %w", err))
		}
		resp.EntryPrice6 = px6.String()
		resp.Signature = "0x" + hex.EncodeToString(sig)
	}

	data, err := json.Marshal(resp)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("encoding response: %w", err))
	}
	return buildResult(action, df, data, 1, nil)
}
