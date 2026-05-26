// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./CourierRegistry.sol";

/**
 * @title OrderService
 * @notice Clients create orders (pay ETH), couriers pick up & deliver,
 *         admin resolves disputes, couriers withdraw weekly.
 */
contract OrderService {

    enum Status {
        Created,     // client paid, waiting for courier
        PickedUp,    // courier accepted
        Delivered,   // courier says delivered, waiting client confirm
        Completed,   // client confirmed — funds credited to courier balance
        Disputed,    // client complained
        Frozen,      // admin froze the funds during investigation
        Refunded,    // admin refunded to client
        Cancelled    // client cancelled before pickup
    }

    struct Order {
        uint256 id;
        address client;
        address courier;
        uint256 amount;        // ETH paid
        string  details;       // off-chain order description / IPFS hash
        Status  status;
        uint256 createdAt;
        uint256 deliveredAt;
    }

    CourierRegistry public registry;
    address public admin;

    uint256 public nextOrderId;
    uint256 public constant CONFIRM_WINDOW = 2 days;  // auto-complete after delivery
    uint256 public constant WITHDRAW_COOLDOWN = 7 days;
    uint256 public constant PLATFORM_FEE_BPS = 500;   // 5 %

    mapping(uint256 => Order) public orders;

    // courier address => claimable balance (after completed orders minus fee)
    mapping(address => uint256) public balances;
    // courier address => last withdrawal timestamp
    mapping(address => uint256) public lastWithdrawal;

    uint256 public platformFees; // accumulated fees for admin

    /* ───────── Events ───────── */

    event OrderCreated(uint256 indexed orderId, address indexed client, uint256 amount);
    event OrderPickedUp(uint256 indexed orderId, address indexed courier);
    event OrderDelivered(uint256 indexed orderId);
    event OrderCompleted(uint256 indexed orderId, uint256 courierPayout);
    event OrderDisputed(uint256 indexed orderId, address indexed client);
    event OrderFrozen(uint256 indexed orderId);
    event OrderRefunded(uint256 indexed orderId, address indexed client, uint256 amount);
    event OrderCancelled(uint256 indexed orderId);
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
    error WithdrawTooEarly(uint256 availableAt);
    error TransferFailed();
    error ZeroPayment();

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

    /// @notice Client confirms delivery — credits courier balance.
    function confirmDelivery(uint256 orderId, uint256 ratingScore) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.client) revert OnlyClient();
        if (o.status != Status.Delivered) revert InvalidStatus();

        _completeOrder(o, ratingScore);
    }

    /// @notice Client opens a dispute after courier marks delivered.
    function disputeOrder(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.client) revert OnlyClient();
        if (o.status != Status.Delivered) revert InvalidStatus();

        o.status = Status.Disputed;
        emit OrderDisputed(orderId, msg.sender);
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

    /// @notice Courier marks order as delivered — starts confirm window.
    function markDelivered(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.courier) revert OnlyCourier();
        if (o.status != Status.PickedUp) revert InvalidStatus();

        o.status = Status.Delivered;
        o.deliveredAt = block.timestamp;
        emit OrderDelivered(orderId);
    }

    /// @notice Anyone can trigger auto-complete after confirm window.
    function autoComplete(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (o.status != Status.Delivered) revert InvalidStatus();
        if (block.timestamp < o.deliveredAt + CONFIRM_WINDOW) {
            revert WithdrawTooEarly(o.deliveredAt + CONFIRM_WINDOW);
        }

        _completeOrder(o, 5); // default 5-star if client never responded
    }

    /// @notice Courier withdraws accumulated balance (once per 7 days).
    function withdraw() external {
        if (!registry.isActiveCourier(msg.sender)) revert NotActiveCourier();
        uint256 bal = balances[msg.sender];
        if (bal == 0) revert NoBalance();

        uint256 nextAllowed = lastWithdrawal[msg.sender] + WITHDRAW_COOLDOWN;
        if (block.timestamp < nextAllowed) revert WithdrawTooEarly(nextAllowed);

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
            _completeOrder(o, 0); // no rating bump on forced resolution
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

    function _completeOrder(Order storage o, uint256 ratingScore) internal {
        uint256 fee = (o.amount * PLATFORM_FEE_BPS) / 10_000;
        uint256 payout = o.amount - fee;

        platformFees += fee;
        balances[o.courier] += payout;
        o.status = Status.Completed;

        // update courier NFT stats
        uint256 tokenId = registry.courierToken(o.courier);
        if (ratingScore > 0 && ratingScore <= 5) {
            registry.addRating(tokenId, ratingScore);
        }
        registry.incrementOrders(tokenId);

        emit OrderCompleted(o.id, payout);
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
}
