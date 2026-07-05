// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IPriceReader} from "./interfaces/IPriceReader.sol";

/// @title TorchVault
/// @notice XRP-margined perps on Flare. Users post FXRP as margin on Flare and
/// positions are executed on Hyperliquid's orderbook by an off-chain executor
/// whose key lives inside a hardware TEE (an attested Intel TDX enclave in the
/// live deployment, migrating to Flare Protocol Managed Wallets when FCC ships
/// on Songbird).
///
/// Trust model (v0, stated honestly):
///  - The executor reports entry / exit prices, but every reported price must
///    sit inside a tight deviation band around Flare's enshrined FTSOv2 feed,
///    so the executor cannot invent prices.
///  - The Hyperliquid API wallet held in the TEE has no withdrawal permission
///    on Hyperliquid, so even a compromised agent key cannot move funds.
///  - Positive PnL is paid from an explicit insurance fund on this contract
///    (in production it is replenished from the hedged Hyperliquid PnL).
///    Negative PnL accrues to the insurance fund.
/// Roadmap: FDC Web2Json attestation of Hyperliquid fills replaces bare
/// executor reports; FCC Protocol Managed Wallets replace the app-run TEE.
contract TorchVault is Ownable, ReentrancyGuard, Pausable {
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
        uint64 hlOid; // Hyperliquid order id (0 in mock mode)
        Status status;
        uint40 openedAt;
        uint40 closedAt;
    }

    // ---------------------------------------------------------------- state

    IERC20 public immutable fxrp;
    uint8 public immutable fxrpDecimals;

    IPriceReader public oracle;
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

    // --------------------------------------------------------------- errors

    error NotExecutor();
    error NotPositionOwner();
    error BadStatus();
    error MarketNotListed();
    error BadLeverage();
    error InsufficientMargin();
    error PriceOutOfBand(uint256 reported, uint256 ftsoPrice);
    error StalePrice();
    error ZeroAmount();
    error NotLiquidatable();

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
        p.status = Status.Cancelled;
        freeMargin[msg.sender] += p.marginFxrp;
        emit RequestCancelled(id);
    }

    function requestClose(uint256 id) external whenNotPaused {
        Position storage p = _positions[id];
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (p.status != Status.Open) revert BadStatus();
        p.status = Status.CloseRequested;
        emit CloseRequested(id);
    }

    // -------------------------------------------------------- executor flow

    /// @notice Executor confirms the Hyperliquid fill. Reported entry price
    /// must sit inside the FTSO deviation band for the market's feed.
    function confirmFill(uint256 id, uint256 entryPrice6, uint64 hlOid) external onlyExecutor nonReentrant {
        Position storage p = _positions[id];
        if (p.status != Status.Requested) revert BadStatus();
        _checkBand(markets[p.market].feedId, entryPrice6);

        uint256 feeUsd6 = (p.sizeUsd6 * openFeeBps) / 10_000;
        uint256 feeFxrp = _usd6ToFxrp(feeUsd6);
        if (feeFxrp >= p.marginFxrp) revert InsufficientMargin();
        p.marginFxrp -= feeFxrp;
        fxrp.safeTransfer(treasury, feeFxrp);

        p.entryPrice6 = entryPrice6;
        p.hlOid = hlOid;
        p.status = Status.Open;
        p.openedAt = uint40(block.timestamp);
        emit PositionOpened(id, entryPrice6, hlOid, feeFxrp);
    }

    /// @notice Executor settles a user-requested close at the Hyperliquid exit
    /// price (band-checked against FTSO).
    function confirmClose(uint256 id, uint256 exitPrice6) external onlyExecutor nonReentrant {
        Position storage p = _positions[id];
        if (p.status != Status.CloseRequested) revert BadStatus();
        _checkBand(markets[p.market].feedId, exitPrice6);
        _settle(p, exitPrice6, false);
    }

    /// @notice Executor liquidates a position whose equity fell below the
    /// maintenance margin. Mark price is band-checked against FTSO, and the
    /// liquidation condition is re-verified on-chain.
    function liquidate(uint256 id, uint256 markPrice6) external onlyExecutor nonReentrant {
        Position storage p = _positions[id];
        if (p.status != Status.Open && p.status != Status.CloseRequested) revert BadStatus();
        _checkBand(markets[p.market].feedId, markPrice6);

        int256 pnlUsd6 = _pnlUsd6(p, markPrice6);
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

        // equity in FXRP after fee, floored at zero
        int256 equityFxrp = int256(p.marginFxrp) + pnlFxrp - int256(feeFxrp);
        uint256 payout = equityFxrp > 0 ? uint256(equityFxrp) : 0;
        if (payout > p.marginFxrp) {
            // profit beyond margin is paid from the insurance fund, capped
            uint256 profit = payout - p.marginFxrp;
            if (profit > insuranceFund) {
                profit = insuranceFund;
                payout = p.marginFxrp + profit;
            }
            insuranceFund -= profit;
        } else {
            // whatever margin is not returned accrues to insurance, minus fee
            uint256 retained = p.marginFxrp - payout;
            uint256 toFee = feeFxrp > retained ? retained : feeFxrp;
            insuranceFund += retained - toFee;
        }

        // pay protocol fee out of retained margin when possible
        uint256 feePayable = feeFxrp;
        uint256 available = p.marginFxrp > payout ? p.marginFxrp - payout : 0;
        if (feePayable > available) feePayable = available;
        if (feePayable > 0) fxrp.safeTransfer(treasury, feePayable);

        freeMargin[p.owner] += payout;
        p.exitPrice6 = price6;
        p.pnlFxrp = pnlFxrp;
        p.closedAt = uint40(block.timestamp);

        if (isLiquidation) {
            p.status = Status.Liquidated;
            uint256 toInsurance = p.marginFxrp > payout + feePayable ? p.marginFxrp - payout - feePayable : 0;
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

    function _checkBand(bytes21 feedId, uint256 reported6) internal view {
        uint256 ref = _price6(feedId);
        uint256 diff = reported6 > ref ? reported6 - ref : ref - reported6;
        if (diff * 10_000 > ref * maxDeviationBps) revert PriceOutOfBand(reported6, ref);
    }

    /// @dev Normalize an FtsoV2-shaped (value, decimals) pair to 6 decimals.
    function _price6(bytes21 feedId) internal view returns (uint256) {
        (uint256 value, int8 dec, uint64 ts) = oracle.getPrice(feedId);
        if (maxPriceAge != 0 && block.timestamp > ts + maxPriceAge) revert StalePrice();
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
