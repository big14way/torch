// Package types contains types that could be useful to other apps when interacting with this extension.
package types

import "github.com/ethereum/go-ethereum/common"

// AttestFillRequest is the JSON payload sent via TorchInstructionSender.
// The vault already stores the Hyperliquid order id at confirmFill time, so a
// caller only has to name the position and the oid it claims backs it.
type AttestFillRequest struct {
	PositionID uint64 `json:"positionId"`
	Oid        uint64 `json:"oid"`
}

// AttestFillResponse is what the enclave returns, and what a Torch contract
// verifies. The enclave fetched this from the exchange itself; the caller
// never gets to choose the numbers.
type AttestFillResponse struct {
	PositionID uint64 `json:"positionId"`
	Oid        uint64 `json:"oid"`
	Coin       string `json:"coin"`
	Side       string `json:"side"`
	Px         string `json:"px"`
	Sz         string `json:"sz"`
	Time       uint64 `json:"time"`
	// Found is false when the exchange has no such fill for our account. The
	// honest negative matters as much as the positive: it is the enclave
	// saying "the operator's claimed order id does not exist".
	Found bool `json:"found"`
	// EntryPrice6 is Px in the vault's 6-decimal fixed point, and Signature is
	// the enclave's signature over TorchTeeExecutor.fillDigest for exactly
	// (positionId, entryPrice6, oid). Present only when Found.
	EntryPrice6 string `json:"entryPrice6,omitempty"`
	Signature   string `json:"signature,omitempty"`
}

// State holds the extension's observable state, returned by GET /state.
type State struct {
	AttestedCount int    `json:"attestedCount"`
	LastOid       uint64 `json:"lastOid"`
	LastCoin      string `json:"lastCoin"`
	LastPx        string `json:"lastPx"`
	NotFoundCount int    `json:"notFoundCount"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}
