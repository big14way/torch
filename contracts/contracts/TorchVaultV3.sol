// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IPriceReader} from "./interfaces/IPriceReader.sol";

/// @title TorchVaultV2
/// @notice XRP-margined perps on Flare. Users post FXRP as margin on Flare and
/// positions are executed on Hyperliquid's orderbook by an off-chain executor
/// whose key lives inside a hardware TEE (an attested Intel TDX enclave in the
/// live deployment, porting to a Flare Confidential Extension on Flare
/// Confidential Compute; Protocol Managed Wallets remain the later endgame).
///
/// v2 adds, all driven by real feedback from the Paper Perps League:
///  - user-set stop-loss / take-profit that the executor may act on ONLY when
///    the contract itself re-reads FTSO and agrees the trigger was crossed;
///  - deposit and notional caps, so open interest can never silently outrun
///    the insurance fund that backs winner payouts;
///  - a PayoutCapped event, so a clamped payout is observable instead of
///    silent;
///  - close/liquidation fees that reach the treasury on winning closes too
///    (v1 only collected them out of retained margin, i.e. from losers);
///  - an owner path to recover insurance funds on migration (v1 had none).
///
/// Trust model (v0, stated honestly):
///  - The executor reports entry / exit prices, but every reported price must
///    sit inside a tight deviation band around Flare's enshrined FTSOv2 feed,
///    so the executor cannot invent prices.
///  - The Hyperliquid API wallet held in the TEE has no withdrawal permission
///    on Hyperliquid, so even a compromised agent key cannot move funds.
///  - Positive PnL is paid from an explicit insurance fund on this contract.
///    Today it is funded manually via fundInsurance; replenishing it from the
///    hedged Hyperliquid PnL is the target design, not yet wired.
///    Negative PnL accrues to the insurance fund.
/// Roadmap: FDC Web2Json attestation of Hyperliquid fills replaces bare
/// executor reports; a Flare Confidential Extension replaces the app-run TEE.
/// Read-only surface of TorchFdcConsumer that the settlement gate consults.
interface IFdcConsumerLike {
    function positionAttestedOid(uint256 positionId) external view returns (uint256);
}

contract TorchVaultV3 is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    enum Status {
        None,
        Requested, // user asked to open, waiting for executor fill
        Open, // filled on Hyperliquid
        CloseRequested, // user asked to close, waiting for executor
        Closed, // settled
        Liquidated, // force-settled below maintenance margin
        Cancelled // user cancelled before fill
    }

    struct Market {
        bytes21 feedId; // FTSOv2 feed id for the traded asset (USD quote)
        bool listed;
        uint16 maxLeverageX10; // 100 = 10x
    }

    struct Position {
        uint256 id;
        address owner;
        bytes32 market; // e.g. bytes32("BTC")
        bool isLong;
        uint256 marginFxrp; // margin locked, in FXRP token units
        uint256 sizeUsd6; // notional in USD, 6 decimals
        uint256 entryPrice6; // asset USD price at fill, 6 decimals
        uint256 exitPrice6; // asset USD price at settle, 6 decimals
        int256 pnlFxrp; // realized PnL in FXRP units (signed)
        uint64 hlOid; // exchange order id (mock mode stores an internal sequence number)
        Status status;
        uint40 openedAt;
        uint40 closedAt;
    }

    // ---------------------------------------------------------------- state

    IERC20 public immutable fxrp;
    uint8 public immutable fxrpDecimals;

    IPriceReader public oracle;

    /// @notice v3: the FDC consumer whose validator-verified fill bindings gate
    /// profitable settlement. Zero until set, and the gate is off while zero,
    /// so the vault can deploy before the consumer that must be bound to it.
    IFdcConsumerLike public fdcConsumer;
    /// @notice How long a venue-routed winner may remain unattested before it
    /// settles anyway. Bounded by selfCloseDelay so the user escape hatch is
    /// never gated: selfClose fires at closeRequestedAt + selfCloseDelay, which
    /// is always >= openedAt + attestGrace when attestGrace <= selfCloseDelay.
    uint256 public attestGrace = 2 hours;
    bytes21 public xrpUsdFeedId;

    address public executor; // TEE agent address
    address public treasury;

    uint16 public maxDeviationBps = 150; // reported price within 1.5% of FTSO
    uint16 public openFeeBps = 8; // 0.08% of notional
    uint16 public closeFeeBps = 8; // 0.08% of notional
    uint16 public maintenanceMarginBps = 500; // 5% of notional
    uint16 public liquidationFeeBps = 100; // 1% of notional
    uint64 public maxPriceAge = 10 minutes;

    uint256 public insuranceFund; // FXRP units backing positive PnL

    // v2: notional caps (0 disables). They exist so open interest can never
    // silently outrun the insurance fund that backs winner payouts.
    uint256 public maxPositionNotionalUsd6;
    uint256 public maxOpenNotionalUsd6;
    uint256 public openNotionalUsd6; // live open interest across filled positions

    // v2: user-set stop-loss / take-profit. 0 = unset. The executor may act on
    // a trigger ONLY when this contract re-reads FTSO and agrees it was
    // crossed -- the same re-verify-on-chain pattern as liquidations.
    struct Triggers {
        uint256 stopPrice6;
        uint256 takeProfitPrice6;
    }
    mapping(uint256 => Triggers) public triggers;

    // v2: when a close was requested, so a user is never trapped waiting on an
    // executor that has stopped. The Jul 2026 enclave outage froze fills for
    // three days; anyone who had clicked Close in that window had no recourse.
    mapping(uint256 => uint40) public closeRequestedAt;
    uint64 public selfCloseDelay = 2 hours;

    // v2: when the executor accepted a request and went to hedge it. Until it
    // does, a user may cancel freely. After it does, cancelling would strand a
    // live hedge, so the user waits out acceptTimeout first -- which still
    // guarantees they are never stuck if the executor dies mid-fill.
    mapping(uint256 => uint40) public fillAcceptedAt;
    uint64 public acceptTimeout = 30 minutes;

    mapping(bytes32 => Market) public markets;
    bytes32[] public marketList;

    Position[] private _positions;
    mapping(address => uint256) public freeMargin; // withdrawable FXRP
    mapping(address => uint256[]) private _userPositionIds;

    // --------------------------------------------------------------- events

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event PositionRequested(
        uint256 indexed id,
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 marginFxrp,
        uint256 sizeUsd6
    );
    event PositionOpened(uint256 indexed id, uint256 entryPrice6, uint64 hlOid, uint256 feeFxrp);
    event CloseRequested(uint256 indexed id);
    event PositionClosed(uint256 indexed id, uint256 exitPrice6, int256 pnlFxrp, uint256 payoutFxrp);
    event PositionLiquidated(uint256 indexed id, uint256 markPrice6, uint256 payoutFxrp, uint256 toInsuranceFxrp);
    event RequestCancelled(uint256 indexed id);
    event InsuranceFunded(address indexed from, uint256 amount);
    event MarketListed(bytes32 indexed market, bytes21 feedId, uint16 maxLeverageX10);
    event ExecutorUpdated(address executor);
    event OracleUpdated(address oracle);
    event ParamsUpdated();

    // v2
    event TriggersUpdated(uint256 indexed id, uint256 stopPrice6, uint256 takeProfitPrice6);
    event TriggerExecuted(uint256 indexed id, bool wasStop, uint256 exitPrice6);
    /// v3: a winner settled without its fill ever being validator-attested —
    /// the grace path. Loud on purpose: honest flow attests within minutes,
    /// so this event marks exactly the fills the validators never confirmed.
    event SettledUnattested(uint256 indexed id, uint64 hlOid);
    event FdcConsumerUpdated(address consumer);
    event AttestGraceUpdated(uint256 secondsGrace);

    event PayoutCapped(uint256 indexed id, uint256 fullPayoutFxrp, uint256 paidFxrp);
    event CapsUpdated(uint256 maxPositionNotionalUsd6, uint256 maxOpenNotionalUsd6);
    event InsuranceWithdrawn(address indexed to, uint256 amount);
    event CloseRequestCancelled(uint256 indexed id);
    event SelfClosed(uint256 indexed id, uint256 oraclePrice6);
    event RequestAccepted(uint256 indexed id);

    // --------------------------------------------------------------- errors

    error NotExecutor();
    error NotPositionOwner();
    error BadStatus();
    error MarketNotListed();
    error BadLeverage();
    error InsufficientMargin();
    error PriceOutOfBand(uint256 reported, uint256 ftsoPrice);
    error StalePrice();
    /// v3: profitable venue-routed settlement awaits validator attestation.
    error AwaitingAttestation();
    error GraceExceedsSelfClose();
    error ZeroAmount();
    error NotLiquidatable();
    error TriggerNotHit();
    error NotionalCapExceeded();
    error TooSoon();

    // ---------------------------------------------------------- constructor

    constructor(
        IERC20 _fxrp,
        IPriceReader _oracle,
        bytes21 _xrpUsdFeedId,
        address _executor,
        address _treasury
    ) Ownable(msg.sender) {
        fxrp = _fxrp;
        fxrpDecimals = IERC20Metadata(address(_fxrp)).decimals();
        oracle = _oracle;
        xrpUsdFeedId = _xrpUsdFeedId;
        executor = _executor;
        treasury = _treasury;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    // ------------------------------------------------------------ user flow

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        fxrp.safeTransferFrom(msg.sender, address(this), amount);
        freeMargin[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = freeMargin[msg.sender];
        if (bal < amount) revert InsufficientMargin();
        freeMargin[msg.sender] = bal - amount;
        fxrp.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @param leverageX10 leverage times ten (10 = 1x, 55 = 5.5x, 100 = 10x)
    function openPosition(
        bytes32 market,
        bool isLong,
        uint256 marginFxrp,
        uint16 leverageX10
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        Market memory m = markets[market];
        if (!m.listed) revert MarketNotListed();
        if (leverageX10 < 10 || leverageX10 > m.maxLeverageX10) revert BadLeverage();
        if (marginFxrp == 0) revert ZeroAmount();
        uint256 bal = freeMargin[msg.sender];
        if (bal < marginFxrp) revert InsufficientMargin();
        freeMargin[msg.sender] = bal - marginFxrp;

        uint256 marginUsd6 = _fxrpToUsd6(marginFxrp);
        uint256 sizeUsd6 = (marginUsd6 * leverageX10) / 10;
        if (maxPositionNotionalUsd6 != 0 && sizeUsd6 > maxPositionNotionalUsd6) {
            revert NotionalCapExceeded();
        }

        id = _positions.length;
        _positions.push(
            Position({
                id: id,
                owner: msg.sender,
                market: market,
                isLong: isLong,
                marginFxrp: marginFxrp,
                sizeUsd6: sizeUsd6,
                entryPrice6: 0,
                exitPrice6: 0,
                pnlFxrp: 0,
                hlOid: 0,
                status: Status.Requested,
                openedAt: 0,
                closedAt: 0
            })
        );
        _userPositionIds[msg.sender].push(id);
        emit PositionRequested(id, msg.sender, market, isLong, marginFxrp, sizeUsd6);
    }

    /// @notice Cancel an open request that the executor has not filled yet.
    function cancelRequest(uint256 id) external nonReentrant {
        Position storage p = _positions[id];
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (p.status != Status.Requested) revert BadStatus();
        // Once the executor has accepted, a hedge is live on the exchange.
        // Cancelling then hands the user a free look at the market at the
        // operator's expense, so make them wait out acceptTimeout. They are
        // still never permanently stuck: the timeout always expires.
        uint40 acceptedAt = fillAcceptedAt[id];
        if (acceptedAt != 0 && block.timestamp < acceptedAt + acceptTimeout) revert TooSoon();
        delete fillAcceptedAt[id];
        p.status = Status.Cancelled;
        freeMargin[msg.sender] += p.marginFxrp;
        emit RequestCancelled(id);
    }

    /// @dev Deliberately NOT whenNotPaused: pause must never trap a user in an
    /// open position while the executor can still liquidate them.
    function requestClose(uint256 id) external {
        Position storage p = _positions[id];
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (p.status != Status.Open) revert BadStatus();
        p.status = Status.CloseRequested;
        closeRequestedAt[id] = uint40(block.timestamp);
        emit CloseRequested(id);
    }

    /// @notice Withdraw your own pending close request and go back to Open.
    /// Costs nothing and is always available: it is your request to retract.
    function cancelCloseRequest(uint256 id) external {
        Position storage p = _positions[id];
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (p.status != Status.CloseRequested) revert BadStatus();
        p.status = Status.Open;
        delete closeRequestedAt[id];
        emit CloseRequestCancelled(id);
    }

    /// @notice Settle your own position at the oracle price when the executor
    /// has not answered your close request within `selfCloseDelay`.
    ///
    /// Without this a stalled executor means a user's margin is locked with no
    /// recourse, which is exactly what happened when the enclave lost funding
    /// mid-league. Settling at FTSO is the same price the executor is bounded
    /// to anyway, so this removes the trap without widening its discretion.
    /// Not whenNotPaused, for the same reason requestClose is not.
    function selfClose(uint256 id) external nonReentrant {
        Position storage p = _positions[id];
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (p.status != Status.CloseRequested) revert BadStatus();
        uint40 requestedAt = closeRequestedAt[id];
        if (requestedAt == 0 || block.timestamp < requestedAt + selfCloseDelay) revert TooSoon();

        uint256 oracle6 = _price6(markets[p.market].feedId);
        emit SelfClosed(id, oracle6);
        _settle(p, oracle6, false);
    }

    /// @notice Set (or clear, with 0) a stop-loss / take-profit on your own
    /// position. The executor can only settle on these when the contract
    /// itself re-reads FTSO and agrees the trigger was crossed.
    /// @dev Not whenNotPaused: setting an exit is risk-reducing.
    function setTriggers(uint256 id, uint256 stopPrice6, uint256 takeProfitPrice6) external {
        Position storage p = _positions[id];
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (p.status != Status.Requested && p.status != Status.Open) revert BadStatus();
        if (stopPrice6 != 0 && takeProfitPrice6 != 0) {
            // a long stops below and takes profit above; a short is mirrored
            bool inverted = p.isLong ? stopPrice6 >= takeProfitPrice6 : stopPrice6 <= takeProfitPrice6;
            if (inverted) revert BadStatus();
        }
        triggers[id] = Triggers(stopPrice6, takeProfitPrice6);
        emit TriggersUpdated(id, stopPrice6, takeProfitPrice6);
    }

    /// @notice Executor settles a position whose user-set stop or take-profit
    /// has been crossed. The FTSO price is read on-chain and must confirm the
    /// crossing (the executor cannot fire an untriggered close), and the
    /// reported exit price must sit inside the deviation band.
    function executeTrigger(uint256 id, uint256 exitPrice6) external onlyExecutor nonReentrant {
        Position storage p = _positions[id];
        if (p.status != Status.Open) revert BadStatus();
        Triggers memory t = triggers[id];
        uint256 ftso = _price6(markets[p.market].feedId);
        bool stopHit = t.stopPrice6 != 0 && (p.isLong ? ftso <= t.stopPrice6 : ftso >= t.stopPrice6);
        bool tpHit = t.takeProfitPrice6 != 0 && (p.isLong ? ftso >= t.takeProfitPrice6 : ftso <= t.takeProfitPrice6);
        if (!stopHit && !tpHit) revert TriggerNotHit();
        _checkBand(markets[p.market].feedId, exitPrice6);
        // Deliberately NOT clamped to the trigger price: when price gaps past
        // a stop the honest exit is beyond it, and clamping would make the
        // position unclosable exactly when the stop matters most.
        _requireNoWorseThanOracle(markets[p.market].feedId, exitPrice6, p.isLong);
        emit TriggerExecuted(id, stopHit, exitPrice6);
        _settle(p, exitPrice6, false);
    }

    // -------------------------------------------------------- executor flow

    /// @notice Executor claims a pending request before it goes to hedge it.
    /// Optional: skipping it only means the user keeps a free cancel.
    function acceptRequest(uint256 id) external onlyExecutor whenNotPaused {
        Position storage p = _positions[id];
        if (p.status != Status.Requested) revert BadStatus();
        fillAcceptedAt[id] = uint40(block.timestamp);
        emit RequestAccepted(id);
    }

    /// @notice Executor confirms the Hyperliquid fill. Reported entry price
    /// must sit inside the FTSO deviation band for the market's feed.
    function confirmFill(uint256 id, uint256 entryPrice6, uint64 hlOid)
        external
        onlyExecutor
        nonReentrant
        whenNotPaused
    {
        Position storage p = _positions[id];
        if (p.status != Status.Requested) revert BadStatus();
        _checkBand(markets[p.market].feedId, entryPrice6);
        // entry: a long wants to buy lower, a short wants to sell higher
        _requireNoWorseThanOracle(markets[p.market].feedId, entryPrice6, !p.isLong);

        // v2: the global cap binds when notional becomes real, at fill time
        if (maxOpenNotionalUsd6 != 0 && openNotionalUsd6 + p.sizeUsd6 > maxOpenNotionalUsd6) {
            revert NotionalCapExceeded();
        }
        openNotionalUsd6 += p.sizeUsd6;

        uint256 feeUsd6 = (p.sizeUsd6 * openFeeBps) / 10_000;
        uint256 feeFxrp = _usd6ToFxrp(feeUsd6);
        if (feeFxrp >= p.marginFxrp) revert InsufficientMargin();
        p.marginFxrp -= feeFxrp;
        fxrp.safeTransfer(treasury, feeFxrp);

        p.entryPrice6 = entryPrice6;
        p.hlOid = hlOid;
        p.status = Status.Open;
        p.openedAt = uint40(block.timestamp);
        delete fillAcceptedAt[id];
        emit PositionOpened(id, entryPrice6, hlOid, feeFxrp);
    }

    /// @notice Executor settles a user-requested close at the Hyperliquid exit
    /// price (band-checked against FTSO).
    function confirmClose(uint256 id, uint256 exitPrice6) external onlyExecutor nonReentrant {
        Position storage p = _positions[id];
        if (p.status != Status.CloseRequested) revert BadStatus();
        _checkBand(markets[p.market].feedId, exitPrice6);
        _requireNoWorseThanOracle(markets[p.market].feedId, exitPrice6, p.isLong);
        _settle(p, exitPrice6, false);
    }

    /// @notice Executor liquidates a position whose equity fell below the
    /// maintenance margin. Mark price is band-checked against FTSO, and the
    /// liquidation condition is re-verified on-chain.
    function liquidate(uint256 id, uint256 markPrice6) external onlyExecutor nonReentrant {
        Position storage p = _positions[id];
        if (p.status != Status.Open && p.status != Status.CloseRequested) revert BadStatus();
        _checkBand(markets[p.market].feedId, markPrice6);
        _requireNoWorseThanOracle(markets[p.market].feedId, markPrice6, p.isLong);

        // Eligibility is decided at the ORACLE, never at the number the
        // executor just supplied -- otherwise shading inside the band could
        // manufacture a liquidation of a position that is genuinely solvent.
        int256 pnlUsd6 = _pnlUsd6(p, _price6(markets[p.market].feedId));
        int256 equityUsd6 = int256(_fxrpToUsd6(p.marginFxrp)) + pnlUsd6;
        int256 maintenanceUsd6 = int256((p.sizeUsd6 * maintenanceMarginBps) / 10_000);
        if (equityUsd6 > maintenanceUsd6) revert NotLiquidatable();
        _settle(p, markPrice6, true);
    }

    // ------------------------------------------------------------- treasury

    /// @notice Fund the insurance pool that backs positive PnL payouts. In
    /// production this is replenished from realized Hyperliquid PnL bridged
    /// back to Flare.
    function fundInsurance(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        fxrp.safeTransferFrom(msg.sender, address(this), amount);
        insuranceFund += amount;
        emit InsuranceFunded(msg.sender, amount);
    }

    /// @notice v2: notional caps; 0 disables a cap.
    /// @notice Tune how long a user must wait before settling their own close.
    /// Bounded so it can never be pushed out far enough to recreate the trap.
    /// @notice How long a user waits to cancel after the executor accepted.
    /// Bounded so it can never become a way to hold a request hostage.
    function setAcceptTimeout(uint64 _timeout) external onlyOwner {
        if (_timeout < 5 minutes || _timeout > 2 hours) revert TooSoon();
        acceptTimeout = _timeout;
        emit ParamsUpdated();
    }

    function setSelfCloseDelay(uint64 _delay) external onlyOwner {
        if (_delay < 15 minutes || _delay > 1 days) revert TooSoon();
        selfCloseDelay = _delay;
        emit ParamsUpdated();
    }

    function setCaps(uint256 _maxPositionNotionalUsd6, uint256 _maxOpenNotionalUsd6) external onlyOwner {
        maxPositionNotionalUsd6 = _maxPositionNotionalUsd6;
        maxOpenNotionalUsd6 = _maxOpenNotionalUsd6;
        emit CapsUpdated(_maxPositionNotionalUsd6, _maxOpenNotionalUsd6);
    }

    /// @notice v2: owner path to move insurance funds out. v1 had none, which
    /// permanently strands its fund on migration. Testnet/migration escape
    /// hatch; retired when the executor moves under FCE governance.
    function withdrawInsurance(uint256 amount, address to) external onlyOwner {
        if (amount > insuranceFund) revert InsufficientMargin();
        insuranceFund -= amount;
        fxrp.safeTransfer(to, amount);
        emit InsuranceWithdrawn(to, amount);
    }

    // ---------------------------------------------------------------- admin

    function listMarket(bytes32 market, bytes21 feedId, uint16 maxLeverageX10) external onlyOwner {
        bool isNew = !markets[market].listed;
        markets[market] = Market({feedId: feedId, listed: true, maxLeverageX10: maxLeverageX10});
        if (isNew) marketList.push(market);
        emit MarketListed(market, feedId, maxLeverageX10);
    }

    function setExecutor(address _executor) external onlyOwner {
        executor = _executor;
        emit ExecutorUpdated(_executor);
    }

    /// v3: bind the FDC consumer. Settable so the consumer (whose constructor
    /// needs this vault's address) can deploy second.
    function setFdcConsumer(address _consumer) external onlyOwner {
        fdcConsumer = IFdcConsumerLike(_consumer);
        emit FdcConsumerUpdated(_consumer);
    }

    function setAttestGrace(uint256 _seconds) external onlyOwner {
        if (_seconds > selfCloseDelay) revert GraceExceedsSelfClose();
        attestGrace = _seconds;
        emit AttestGraceUpdated(_seconds);
    }

    function setOracle(IPriceReader _oracle) external onlyOwner {
        oracle = _oracle;
        emit OracleUpdated(address(_oracle));
    }

    function setParams(
        uint16 _maxDeviationBps,
        uint16 _openFeeBps,
        uint16 _closeFeeBps,
        uint16 _maintenanceMarginBps,
        uint16 _liquidationFeeBps,
        uint64 _maxPriceAge
    ) external onlyOwner {
        // Unbounded setters would let the owner widen the band to anything and
        // then sweep the resulting margin through withdrawInsurance. Bound them.
        if (_maxDeviationBps == 0 || _maxDeviationBps > 300) revert BadLeverage();
        if (_maintenanceMarginBps > 2_000) revert BadLeverage();
        if (_liquidationFeeBps > 500) revert BadLeverage();
        if (_openFeeBps > 100 || _closeFeeBps > 100) revert BadLeverage();
        if (_maxPriceAge < 60 || _maxPriceAge > 1 hours) revert StalePrice();
        maxDeviationBps = _maxDeviationBps;
        openFeeBps = _openFeeBps;
        closeFeeBps = _closeFeeBps;
        maintenanceMarginBps = _maintenanceMarginBps;
        liquidationFeeBps = _liquidationFeeBps;
        maxPriceAge = _maxPriceAge;
        emit ParamsUpdated();
    }

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------- views

    function positionsCount() external view returns (uint256) {
        return _positions.length;
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    function getUserPositions(address user) external view returns (Position[] memory out) {
        uint256[] storage ids = _userPositionIds[user];
        out = new Position[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = _positions[ids[i]];
        }
    }

    function listMarkets() external view returns (bytes32[] memory) {
        return marketList;
    }

    /// @notice Current FTSO mark price for a listed market, normalized to 6dp.
    function markPrice6(bytes32 market) external view returns (uint256) {
        Market memory m = markets[market];
        if (!m.listed) revert MarketNotListed();
        return _price6(m.feedId);
    }

    /// @notice Live equity of a position in USD 6dp at the FTSO mark. Used by
    /// the UI and the executor's liquidation watcher.
    function equityUsd6(uint256 id) external view returns (int256) {
        Position memory p = _positions[id];
        if (p.status != Status.Open && p.status != Status.CloseRequested) return 0;
        uint256 mark = _price6(markets[p.market].feedId);
        return int256(_fxrpToUsd6(p.marginFxrp)) + _pnlUsd6ThroughMemory(p, mark);
    }

    // ------------------------------------------------------------- internal

    function _settle(Position storage p, uint256 price6, bool isLiquidation) internal {
        int256 pnlUsd6 = _pnlUsd6(p, price6);
        uint256 xrpPx = _price6(xrpUsdFeedId);

        uint256 feeUsd6 = (p.sizeUsd6 * (isLiquidation ? liquidationFeeBps : closeFeeBps)) / 10_000;
        uint256 feeFxrp = _usd6ToFxrpAt(feeUsd6, xrpPx);
        int256 pnlFxrp = _usd6ToFxrpSignedAt(pnlUsd6, xrpPx);

        // v2 accounting. Conservation per settle:
        //   margin + fundDraw == payout + fee(treasury) + fundCredit
        // Gross equity before fee, floored at zero (losses cap at margin).
        int256 grossFxrp = int256(p.marginFxrp) + pnlFxrp;
        uint256 gross = grossFxrp > 0 ? uint256(grossFxrp) : 0;
        uint256 toInsurance = 0;

        if (gross > p.marginFxrp) {
            // v3 gate: profit is paid from the insurance fund, so profit is
            // what needs proof. A venue-routed winner settles at full value
            // only once Flare's validators have re-proved its entry fill
            // (consumer binding == the oid the vault stored), or after
            // attestGrace — never trapped, but the grace path is flagged
            // on-chain. Losses need no proof: they pay INTO the fund.
            // Honest flow is untouched: the enclave auto-attests every venue
            // fill within minutes of open, long before any close.
            if (p.hlOid != 0 && address(fdcConsumer) != address(0)) {
                if (fdcConsumer.positionAttestedOid(p.id) != p.hlOid) {
                    if (block.timestamp < uint256(p.openedAt) + attestGrace) {
                        revert AwaitingAttestation();
                    }
                    emit SettledUnattested(p.id, p.hlOid);
                }
            }
            // Winner: profit beyond margin is paid from the insurance fund.
            // The cap still exists -- margin is always whole, only profit can
            // clamp -- but a clamped payout is now observable, not silent.
            uint256 profit = gross - p.marginFxrp;
            if (profit > insuranceFund) {
                emit PayoutCapped(p.id, gross, p.marginFxrp + insuranceFund);
                profit = insuranceFund;
                gross = p.marginFxrp + profit;
            }
            insuranceFund -= profit;
        } else {
            // Loser: retained margin accrues to the insurance fund.
            toInsurance = p.marginFxrp - gross;
            insuranceFund += toInsurance;
        }

        // The close/liquidation fee is part of the trader's cost and reaches
        // the treasury on winners and losers alike. (v1 collected it only out
        // of retained margin, so profitable closes paid the treasury nothing.)
        uint256 fee = feeFxrp > gross ? gross : feeFxrp;
        uint256 payout = gross - fee;
        if (fee > 0) fxrp.safeTransfer(treasury, fee);

        openNotionalUsd6 -= p.sizeUsd6; // was added at fill
        delete closeRequestedAt[p.id];

        freeMargin[p.owner] += payout;
        p.exitPrice6 = price6;
        p.pnlFxrp = pnlFxrp;
        p.closedAt = uint40(block.timestamp);

        if (isLiquidation) {
            p.status = Status.Liquidated;
            emit PositionLiquidated(p.id, price6, payout, toInsurance);
        } else {
            p.status = Status.Closed;
            emit PositionClosed(p.id, price6, pnlFxrp, payout);
        }
    }

    function _pnlUsd6(Position storage p, uint256 price6) internal view returns (int256) {
        int256 entry = int256(p.entryPrice6);
        int256 mark = int256(price6);
        int256 size = int256(p.sizeUsd6);
        if (p.isLong) {
            return (size * (mark - entry)) / entry;
        }
        return (size * (entry - mark)) / entry;
    }

    function _pnlUsd6ThroughMemory(Position memory p, uint256 price6) internal pure returns (int256) {
        int256 entry = int256(p.entryPrice6);
        int256 mark = int256(price6);
        int256 size = int256(p.sizeUsd6);
        if (p.isLong) {
            return (size * (mark - entry)) / entry;
        }
        return (size * (entry - mark)) / entry;
    }

    /// @dev The band alone still lets the executor pick the bad end of it, which
    /// at 10x is 15% of margin per leg. Torch's stated policy is that venue
    /// drift is "basis risk carried by the operator, never by the user", so a
    /// reported price may be better for the user than the oracle but never
    /// worse. `betterIsHigher` is true when a higher price favours the user:
    /// closing a long, or opening a short.
    function _requireNoWorseThanOracle(
        bytes21 feedId,
        uint256 reported6,
        bool betterIsHigher
    ) internal view {
        uint256 ref = _price6(feedId);
        if (betterIsHigher ? reported6 < ref : reported6 > ref) {
            revert PriceOutOfBand(reported6, ref);
        }
    }

    function _checkBand(bytes21 feedId, uint256 reported6) internal view {
        uint256 ref = _price6(feedId);
        uint256 diff = reported6 > ref ? reported6 - ref : ref - reported6;
        if (diff * 10_000 > ref * maxDeviationBps) revert PriceOutOfBand(reported6, ref);
    }

    /// @dev Normalize an FtsoV2-shaped (value, decimals) pair to 6 decimals.
    function _price6(bytes21 feedId) internal view returns (uint256) {
        (uint256 value, int8 dec, uint64 ts) = oracle.getPrice(feedId);
        if (maxPriceAge != 0 && block.timestamp > ts + maxPriceAge) revert StalePrice();
        // A zero price would sail through _checkBand (diff 0) and then store
        // entryPrice6 = 0, after which every _pnlUsd6 divides by zero and the
        // position can never be closed. Fail closed instead.
        if (value == 0) revert StalePrice();
        if (dec == 6) return value;
        if (dec > 6) return value / (10 ** uint256(uint8(dec - 6)));
        // dec < 6 covers negative decimals too: scale up by (6 - dec)
        int256 shift = 6 - int256(dec);
        return value * (10 ** uint256(shift));
    }

    function _fxrpToUsd6(uint256 amountFxrp) internal view returns (uint256) {
        uint256 px = _price6(xrpUsdFeedId);
        return (amountFxrp * px) / (10 ** fxrpDecimals);
    }

    function _usd6ToFxrp(uint256 usd6) internal view returns (uint256) {
        uint256 px = _price6(xrpUsdFeedId);
        return (usd6 * (10 ** fxrpDecimals)) / px;
    }

    function _usd6ToFxrpAt(uint256 usd6, uint256 xrpPx6) internal view returns (uint256) {
        return (usd6 * (10 ** fxrpDecimals)) / xrpPx6;
    }

    function _usd6ToFxrpSignedAt(int256 usd6, uint256 xrpPx6) internal view returns (int256) {
        int256 scale = int256(10 ** fxrpDecimals);
        return (usd6 * scale) / int256(xrpPx6);
    }
}
