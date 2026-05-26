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
│  CLIENT            COURIER           ADMIN              │
│  ───────           ────────          ──────             │
│  createOrder       pickUpOrder       freezeOrder        │
│  cancelOrder       markDelivered     resolveDispute     │
│  disputeOrder      withdraw          withdrawFees       │
│  rateOrder         (finalizeOrder)                      │
│                                                         │
│  5% platform fee ─ 2-day dispute window ─ 7-day w/d CD │
└─────────────────────────────────────────────────────────┘
```

## Order Lifecycle

Courier marks done → 2-day dispute window → if client silent → finalize → money to courier.

No client confirmation needed.

```
Created ──pickup──→ PickedUp ──markDelivered──→ Delivered
   │                                              │    │
   │ cancel                              dispute  │    │ 2 days pass
   ▼                                  (< 2 days)  │    │ no dispute
Cancelled                                  │      │    │
                                           ▼      │    ▼
                                       Disputed   │  finalizeOrder()
                                           │      │    │
                                     freeze (admin)│    ▼
                                           │      │  Completed
                                        Frozen    │  (courier credited)
                                        │     │   │
                             refund ────┘     └───┘
                                │           release
                             Refunded      Completed
```

## How It Works

1. **Client** calls `createOrder()` and pays ETH upfront
2. **Courier** calls `pickUpOrder()` to accept
3. **Courier** calls `markDelivered()` when done — starts 2-day dispute window
4. **Client** has 2 days to:
   - `disputeOrder()` — if something went wrong
   - `rateOrder(score)` — optional 1-5 rating (doesn't block finalization)
   - Do nothing — order auto-finalizes
5. After 2 days with no dispute, **anyone** calls `finalizeOrder()` → courier gets paid (minus 5% fee)
6. **Courier** calls `withdraw()` once per week to collect all earned ETH

### Dispute Resolution

1. Client calls `disputeOrder()` within 2-day window
2. Admin calls `freezeOrder()` to lock funds during investigation
3. Admin calls `resolveDispute(orderId, refund)`:
   - `refund = true` → ETH returned to client
   - `refund = false` → courier gets credited

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
| Dispute window | 2 days | `DISPUTE_WINDOW` |
| Withdraw cooldown | 7 days | `WITHDRAW_COOLDOWN` |

## Test Results (38 passing)

```
CourierRegistry (7)
  ✔ admin can add/remove couriers
  ✔ rejects duplicates, non-admin blocked
  ✔ soulbound — transfer blocked
  ✔ rating & order count tracking

Happy path — auto-finalize (6)
  ✔ create → pickup → deliver → wait 2 days → finalize
  ✔ anyone can call finalize
  ✔ cancel before pickup / blocked after

Client rating (6)
  ✔ rate during dispute window or after completion
  ✔ rating does not block finalization
  ✔ cannot rate twice, invalid scores rejected

Disputes (8)
  ✔ dispute within 2-day window
  ✔ CANNOT dispute after window expires
  ✔ admin freeze → refund or release
  ✔ cannot finalize disputed order

Weekly withdrawal (4)
  ✔ withdraw accumulated balance
  ✔ 7-day cooldown enforced
  ✔ inactive courier blocked

Platform fees (2) + Access control (5)
```

## Security Notes

- Courier NFTs are **soulbound** — cannot be transferred or sold
- `addRating` / `incrementOrders` on the registry are public — in production, restrict to the OrderService address
- Uses `call{value}` with checks-effects-interactions pattern
- Consider adding ReentrancyGuard from OpenZeppelin for extra safety
- Admin is a single EOA — consider upgrading to a multisig or DAO for production
- `finalizeOrder` is permissionless — can be called by a keeper bot or the courier themselves
