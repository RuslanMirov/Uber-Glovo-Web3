// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./CourierRegistry.sol";

/**
 * @title OrderService
 * @notice Clients create orders (pay ETH), couriers pick up & mark done.
 *         Client has 2-day window to dispute. If no dispute — money goes
 *         to courier on finalize(). Couriers withdraw weekly.
 *
 *  Flow:  Created → PickedUp → Delivered ──(2 days)──→ finalize → Completed
 *                                  │
 *                                  ├─ disputeOrder (within 2 days)
 *                                  │       → Disputed → Frozen → Refunded / Completed
 *                                  │
 *                                  └─ rateOrder (optional, within 2 days)
 */
contract OrderService {

    enum Status {
        Created,     // client paid, waiting for courier
        PickedUp,    // courier accepted
        Delivered,   // courier marked done — 2-day dispute window running
        Completed,   // finalized — funds credited to courier
        Disputed,    // client complained within window
        Frozen,      // admin froze during investigation
        Refunded,    // admin refunded client
        Cancelled    // client cancelled before pickup
    }

    struct Order {
        uint256 id;
        address client;
        address courier;
        uint256 amount;        // ETH paid
        string  details;       // off-chain description / IPFS hash
        Status  status;
        uint256 createdAt;
        uint256 deliveredAt;
    }

    CourierRegistry public registry;
    address public admin;

    uint256 public nextOrderId;
    uint256 public constant DISPUTE_WINDOW = 2 days;       // client can complain within this
    uint256 public constant WITHDRAW_COOLDOWN = 7 days;
    uint256 public constant PLATFORM_FEE_BPS = 500;        // 5 %

    mapping(uint256 => Order) public orders;

    // courier address => claimable balance
    mapping(address => uint256) public balances;
    // courier address => last withdrawal timestamp
    mapping(address => uint256) public lastWithdrawal;
    // orderId => client rating (0 = not rated)
    mapping(uint256 => uint256) public orderRating;

    uint256 public platformFees;

    /* ───────── Events ───────── */

    event OrderCreated(uint256 indexed orderId, address indexed client, uint256 amount);
    event OrderPickedUp(uint256 indexed orderId, address indexed courier);
    event OrderDelivered(uint256 indexed orderId, uint256 disputeDeadline);
    event OrderFinalized(uint256 indexed orderId, uint256 courierPayout);
    event OrderDisputed(uint256 indexed orderId, address indexed client);
    event OrderFrozen(uint256 indexed orderId);
    event OrderRefunded(uint256 indexed orderId, address indexed client, uint256 amount);
    event OrderCancelled(uint256 indexed orderId);
    event OrderRated(uint256 indexed orderId, uint256 score);
    event DisputeResolved(uint256 indexed orderId, bool refunded);
    event Withdrawal(address indexed courier, uint256 amount);
    event FeeWithdrawn(address indexed admin, uint256 amount);

    /* ───────── Errors ───────── */

    error OnlyAdmin();
    error OnlyCourier();
    error OnlyClient();
    error InvalidStatus();
    error NotActiveCourier();
    error NoBalance();
    error TooEarly(uint256 availableAt);
    error TooLate();
    error TransferFailed();
    error ZeroPayment();
    error AlreadyRated();
    error InvalidRating();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    constructor(address _registry) {
        registry = CourierRegistry(_registry);
        admin = msg.sender;
    }

    /* ═══════════════════  CLIENT ACTIONS  ═══════════════════ */

    /// @notice Client creates an order and pays ETH upfront.
    function createOrder(string calldata details) external payable returns (uint256 orderId) {
        if (msg.value == 0) revert ZeroPayment();

        orderId = nextOrderId++;
        orders[orderId] = Order({
            id: orderId,
            client: msg.sender,
            courier: address(0),
            amount: msg.value,
            details: details,
            status: Status.Created,
            createdAt: block.timestamp,
            deliveredAt: 0
        });

        emit OrderCreated(orderId, msg.sender, msg.value);
    }

    /// @notice Client cancels before any courier picked up.
    function cancelOrder(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.client) revert OnlyClient();
        if (o.status != Status.Created) revert InvalidStatus();

        o.status = Status.Cancelled;

        (bool ok,) = o.client.call{value: o.amount}("");
        if (!ok) revert TransferFailed();

        emit OrderCancelled(orderId);
    }

    /// @notice Client disputes within 2-day window after delivery.
    function disputeOrder(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.client) revert OnlyClient();
        if (o.status != Status.Delivered) revert InvalidStatus();
        if (block.timestamp > o.deliveredAt + DISPUTE_WINDOW) revert TooLate();

        o.status = Status.Disputed;
        emit OrderDisputed(orderId, msg.sender);
    }

    /// @notice Client optionally rates courier (1-5) during dispute window.
    ///         Does NOT block finalization — just records a score.
    function rateOrder(uint256 orderId, uint256 score) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.client) revert OnlyClient();
        // can rate while Delivered or after Completed
        if (o.status != Status.Delivered && o.status != Status.Completed) revert InvalidStatus();
        if (orderRating[orderId] != 0) revert AlreadyRated();
        if (score < 1 || score > 5) revert InvalidRating();

        orderRating[orderId] = score;

        uint256 tokenId = registry.courierToken(o.courier);
        registry.addRating(tokenId, score);

        emit OrderRated(orderId, score);
    }

    /* ═══════════════════  COURIER ACTIONS  ═══════════════════ */

    /// @notice Active courier picks up an open order.
    function pickUpOrder(uint256 orderId) external {
        if (!registry.isActiveCourier(msg.sender)) revert NotActiveCourier();
        Order storage o = orders[orderId];
        if (o.status != Status.Created) revert InvalidStatus();

        o.courier = msg.sender;
        o.status = Status.PickedUp;
        emit OrderPickedUp(orderId, msg.sender);
    }

    /// @notice Courier marks order as done — starts 2-day dispute window.
    function markDelivered(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.courier) revert OnlyCourier();
        if (o.status != Status.PickedUp) revert InvalidStatus();

        o.status = Status.Delivered;
        o.deliveredAt = block.timestamp;
        emit OrderDelivered(orderId, block.timestamp + DISPUTE_WINDOW);
    }

    /// @notice Anyone can finalize after dispute window expires.
    ///         Credits courier balance (minus 5% fee).
    function finalizeOrder(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (o.status != Status.Delivered) revert InvalidStatus();
        if (block.timestamp < o.deliveredAt + DISPUTE_WINDOW) {
            revert TooEarly(o.deliveredAt + DISPUTE_WINDOW);
        }

        _completeOrder(o);
    }

    /// @notice Courier withdraws accumulated balance (once per 7 days).
    function withdraw() external {
        if (!registry.isActiveCourier(msg.sender)) revert NotActiveCourier();
        uint256 bal = balances[msg.sender];
        if (bal == 0) revert NoBalance();

        uint256 nextAllowed = lastWithdrawal[msg.sender] + WITHDRAW_COOLDOWN;
        if (block.timestamp < nextAllowed) revert TooEarly(nextAllowed);

        balances[msg.sender] = 0;
        lastWithdrawal[msg.sender] = block.timestamp;

        (bool ok,) = msg.sender.call{value: bal}("");
        if (!ok) revert TransferFailed();

        emit Withdrawal(msg.sender, bal);
    }

    /* ═══════════════════  ADMIN ACTIONS  ═══════════════════ */

    /// @notice Admin freezes disputed order funds.
    function freezeOrder(uint256 orderId) external onlyAdmin {
        Order storage o = orders[orderId];
        if (o.status != Status.Disputed) revert InvalidStatus();

        o.status = Status.Frozen;
        emit OrderFrozen(orderId);
    }

    /// @notice Admin resolves dispute: refund=true → client gets ETH back,
    ///         refund=false → courier gets credited.
    function resolveDispute(uint256 orderId, bool refund) external onlyAdmin {
        Order storage o = orders[orderId];
        if (o.status != Status.Frozen && o.status != Status.Disputed) revert InvalidStatus();

        if (refund) {
            o.status = Status.Refunded;
            (bool ok,) = o.client.call{value: o.amount}("");
            if (!ok) revert TransferFailed();
            emit OrderRefunded(orderId, o.client, o.amount);
        } else {
            _completeOrder(o);
        }

        emit DisputeResolved(orderId, refund);
    }

    /// @notice Admin withdraws accumulated platform fees.
    function withdrawFees() external onlyAdmin {
        uint256 amount = platformFees;
        if (amount == 0) revert NoBalance();
        platformFees = 0;

        (bool ok,) = admin.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit FeeWithdrawn(admin, amount);
    }

    /* ═══════════════════  INTERNAL  ═══════════════════ */

    function _completeOrder(Order storage o) internal {
        uint256 fee = (o.amount * PLATFORM_FEE_BPS) / 10_000;
        uint256 payout = o.amount - fee;

        platformFees += fee;
        balances[o.courier] += payout;
        o.status = Status.Completed;

        // bump courier order count on NFT
        uint256 tokenId = registry.courierToken(o.courier);
        registry.incrementOrders(tokenId);

        emit OrderFinalized(o.id, payout);
    }

    /* ═══════════════════  VIEWS  ═══════════════════ */

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function courierBalance(address courier) external view returns (uint256) {
        return balances[courier];
    }

    function nextWithdrawTime(address courier) external view returns (uint256) {
        return lastWithdrawal[courier] + WITHDRAW_COOLDOWN;
    }

    function disputeDeadline(uint256 orderId) external view returns (uint256) {
        return orders[orderId].deliveredAt + DISPUTE_WINDOW;
    }
}
