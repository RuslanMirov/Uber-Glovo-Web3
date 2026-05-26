# Glovo Onchain

On-chain delivery protocol — clients order & pay ETH, couriers deliver & earn, admin moderates disputes.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CourierRegistry                       │
│  ERC-721 Soulbound NFT                                  │
│  ─ addCourier / removeCourier  (admin only)             │
│  ─ rating, ratingCount, ordersCount per tokenId         │
│  ─ transfers blocked (soulbound)                        │
└──────────────────────┬──────────────────────────────────┘
                       │ reads/writes courier stats
┌──────────────────────▼──────────────────────────────────┐
│                     OrderService                        │
│                                                         │
│  CLIENT          COURIER           ADMIN                │
│  ───────         ────────          ──────               │
│  createOrder     pickUpOrder       freezeOrder          │
│  cancelOrder     markDelivered     resolveDispute       │
│  confirmDelivery withdraw          withdrawFees         │
│  disputeOrder    (auto-complete)                        │
│                                                         │
│  5% platform fee ─ 2-day confirm window ─ 7-day w/d CD │
└─────────────────────────────────────────────────────────┘
```

## Order Lifecycle

```
Created ──pickup──→ PickedUp ──deliver──→ Delivered
   │                                        │  │  │
   │ cancel                       confirm ──┘  │  │ (2d timeout)
   ▼                                  │        │  └──→ auto-complete
Cancelled                        Completed     │
                                          dispute ──→ Disputed
                                                        │
                                                  freeze (admin)
                                                        │
                                                     Frozen
                                                     │     │
                                          refund ────┘     └──── release
                                             │                     │
                                          Refunded            Completed
```

## Setup

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Run Demo

```bash
npx hardhat run scripts/demo.js
```

## Deploy

```bash
# Local
npx hardhat run scripts/deploy.js

# Testnet (add network to hardhat.config.js first)
npx hardhat run scripts/deploy.js --network sepolia
```

## Key Parameters

| Parameter | Value | Location |
|-----------|-------|----------|
| Platform fee | 5% (500 bps) | `PLATFORM_FEE_BPS` |
| Confirm window | 2 days | `CONFIRM_WINDOW` |
| Withdraw cooldown | 7 days | `WITHDRAW_COOLDOWN` |

## Test Results

```
30 passing

  CourierRegistry
    ✔ admin can add a courier and mint NFT
    ✔ rejects duplicate courier
    ✔ non-admin cannot add courier
    ✔ admin can remove courier
    ✔ NFT is soulbound — transfer blocked
    ✔ average rating is calculated correctly
    ✔ incrementOrders bumps count

  OrderService — happy path
    ✔ client creates order with ETH
    ✔ rejects zero-value order
    ✔ full lifecycle: create → pickup → deliver → confirm
    ✔ client can cancel before pickup
    ✔ cannot cancel after pickup

  OrderService — disputes
    ✔ client can dispute a delivered order
    ✔ admin can freeze disputed order
    ✔ admin resolves dispute with refund to client
    ✔ admin resolves dispute in courier's favor
    ✔ non-admin cannot freeze or resolve
    ✔ cannot dispute non-delivered order

  OrderService — auto-complete
    ✔ reverts if confirm window has not passed
    ✔ auto-completes after 2-day window with 5-star default

  OrderService — weekly withdrawal
    ✔ courier can withdraw accumulated balance
    ✔ cannot withdraw twice within 7 days
    ✔ can withdraw again after 7 days
    ✔ inactive courier cannot withdraw

  OrderService — platform fees
    ✔ admin withdraws accumulated fees
    ✔ non-admin cannot withdraw fees

  Access control edge cases
    ✔ non-courier cannot pick up order
    ✔ wrong courier cannot mark delivered
    ✔ wrong client cannot confirm delivery
    ✔ deactivated courier cannot pick up new orders
```

## Security Notes

- Courier NFTs are **soulbound** — cannot be transferred or sold
- `addRating` / `incrementOrders` on the registry are **public** — in production, restrict to the OrderService address via an access control modifier
- Uses `call{value}` for ETH transfers (reentrancy safe due to state changes before external calls)
- Consider adding ReentrancyGuard from OpenZeppelin for extra safety
- Admin is a single EOA — consider upgrading to a multisig or DAO for production
