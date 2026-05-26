const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Glovo Onchain", function () {
  let registry, service;
  let admin, courier1, courier2, client1, client2;

  const ETH1 = ethers.parseEther("1");
  const ETH2 = ethers.parseEther("2");
  const WEEK = 7 * 24 * 3600;
  const TWO_DAYS = 2 * 24 * 3600;

  beforeEach(async function () {
    [admin, courier1, courier2, client1, client2] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("CourierRegistry");
    registry = await Registry.deploy();

    const Service = await ethers.getContractFactory("OrderService");
    service = await Service.deploy(await registry.getAddress());
  });

  /* ============================================================
     COURIER REGISTRY
     ============================================================ */

  describe("CourierRegistry", function () {
    it("admin can add a courier and mint NFT", async function () {
      const tx = await registry.addCourier(courier1.address);
      await expect(tx)
        .to.emit(registry, "CourierAdded")
        .withArgs(courier1.address, 1);

      expect(await registry.ownerOf(1)).to.equal(courier1.address);
      expect(await registry.isActiveCourier(courier1.address)).to.be.true;
    });

    it("rejects duplicate courier", async function () {
      await registry.addCourier(courier1.address);
      await expect(registry.addCourier(courier1.address))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("non-admin cannot add courier", async function () {
      await expect(registry.connect(client1).addCourier(courier1.address))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("admin can remove courier", async function () {
      await registry.addCourier(courier1.address);
      await expect(registry.removeCourier(courier1.address))
        .to.emit(registry, "CourierRemoved")
        .withArgs(courier1.address, 1);

      expect(await registry.isActiveCourier(courier1.address)).to.be.false;
    });

    it("NFT is soulbound — transfer blocked", async function () {
      await registry.addCourier(courier1.address);
      await expect(
        registry.connect(courier1).transferFrom(courier1.address, client1.address, 1)
      ).to.be.revertedWithCustomError(registry, "SoulboundTransfer");
    });

    it("average rating is calculated correctly", async function () {
      await registry.addCourier(courier1.address);
      // 5 + 3 = 8 / 2 = 4.00 → 400
      await registry.addRating(1, 5);
      await registry.addRating(1, 3);
      expect(await registry.averageRating(1)).to.equal(400);
    });

    it("incrementOrders bumps count", async function () {
      await registry.addCourier(courier1.address);
      await registry.incrementOrders(1);
      await registry.incrementOrders(1);
      const info = await registry.couriers(1);
      expect(info.ordersCount).to.equal(2);
    });
  });

  /* ============================================================
     ORDER SERVICE — HAPPY PATH
     ============================================================ */

  describe("OrderService — happy path", function () {
    beforeEach(async function () {
      await registry.addCourier(courier1.address);
    });

    it("client creates order with ETH", async function () {
      await expect(
        service.connect(client1).createOrder("Pizza Margherita", { value: ETH1 })
      )
        .to.emit(service, "OrderCreated")
        .withArgs(0, client1.address, ETH1);

      const o = await service.getOrder(0);
      expect(o.client).to.equal(client1.address);
      expect(o.amount).to.equal(ETH1);
      expect(o.status).to.equal(0); // Created
    });

    it("rejects zero-value order", async function () {
      await expect(
        service.connect(client1).createOrder("test", { value: 0 })
      ).to.be.revertedWithCustomError(service, "ZeroPayment");
    });

    it("full lifecycle: create → pickup → deliver → confirm", async function () {
      await service.connect(client1).createOrder("Sushi", { value: ETH1 });

      // pickup
      await expect(service.connect(courier1).pickUpOrder(0))
        .to.emit(service, "OrderPickedUp")
        .withArgs(0, courier1.address);

      // deliver
      await expect(service.connect(courier1).markDelivered(0))
        .to.emit(service, "OrderDelivered")
        .withArgs(0);

      // confirm with 5-star rating
      const fee = ETH1 * 500n / 10000n; // 5%
      const payout = ETH1 - fee;

      await expect(service.connect(client1).confirmDelivery(0, 5))
        .to.emit(service, "OrderCompleted")
        .withArgs(0, payout);

      expect(await service.courierBalance(courier1.address)).to.equal(payout);
      expect(await service.platformFees()).to.equal(fee);

      // check NFT stats updated
      const info = await registry.couriers(1);
      expect(info.ordersCount).to.equal(1);
      expect(info.ratingCount).to.equal(1);
      expect(info.rating).to.equal(5);
    });

    it("client can cancel before pickup", async function () {
      await service.connect(client1).createOrder("Cancel me", { value: ETH1 });
      const balBefore = await ethers.provider.getBalance(client1.address);

      const tx = await service.connect(client1).cancelOrder(0);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const balAfter = await ethers.provider.getBalance(client1.address);
      expect(balAfter + gasCost - balBefore).to.equal(ETH1);

      const o = await service.getOrder(0);
      expect(o.status).to.equal(7); // Cancelled
    });

    it("cannot cancel after pickup", async function () {
      await service.connect(client1).createOrder("test", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(0);
      await expect(service.connect(client1).cancelOrder(0))
        .to.be.revertedWithCustomError(service, "InvalidStatus");
    });
  });

  /* ============================================================
     ORDER SERVICE — DISPUTES
     ============================================================ */

  describe("OrderService — disputes", function () {
    beforeEach(async function () {
      await registry.addCourier(courier1.address);
      await service.connect(client1).createOrder("Burger", { value: ETH2 });
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
    });

    it("client can dispute a delivered order", async function () {
      await expect(service.connect(client1).disputeOrder(0))
        .to.emit(service, "OrderDisputed")
        .withArgs(0, client1.address);

      const o = await service.getOrder(0);
      expect(o.status).to.equal(4); // Disputed
    });

    it("admin can freeze disputed order", async function () {
      await service.connect(client1).disputeOrder(0);
      await expect(service.freezeOrder(0))
        .to.emit(service, "OrderFrozen")
        .withArgs(0);

      const o = await service.getOrder(0);
      expect(o.status).to.equal(5); // Frozen
    });

    it("admin resolves dispute with refund to client", async function () {
      await service.connect(client1).disputeOrder(0);
      await service.freezeOrder(0);

      const balBefore = await ethers.provider.getBalance(client1.address);
      await expect(service.resolveDispute(0, true))
        .to.emit(service, "OrderRefunded")
        .withArgs(0, client1.address, ETH2)
        .and.to.emit(service, "DisputeResolved")
        .withArgs(0, true);

      const balAfter = await ethers.provider.getBalance(client1.address);
      expect(balAfter - balBefore).to.equal(ETH2);

      const o = await service.getOrder(0);
      expect(o.status).to.equal(6); // Refunded
    });

    it("admin resolves dispute in courier's favor", async function () {
      await service.connect(client1).disputeOrder(0);
      await service.freezeOrder(0);

      const fee = ETH2 * 500n / 10000n;
      const payout = ETH2 - fee;

      await expect(service.resolveDispute(0, false))
        .to.emit(service, "OrderCompleted")
        .withArgs(0, payout)
        .and.to.emit(service, "DisputeResolved")
        .withArgs(0, false);

      expect(await service.courierBalance(courier1.address)).to.equal(payout);
    });

    it("non-admin cannot freeze or resolve", async function () {
      await service.connect(client1).disputeOrder(0);
      await expect(service.connect(client1).freezeOrder(0))
        .to.be.revertedWithCustomError(service, "OnlyAdmin");
      await expect(service.connect(client1).resolveDispute(0, true))
        .to.be.revertedWithCustomError(service, "OnlyAdmin");
    });

    it("cannot dispute non-delivered order", async function () {
      // create a fresh order still in Created status
      await service.connect(client1).createOrder("test", { value: ETH1 });
      await expect(service.connect(client1).disputeOrder(1))
        .to.be.revertedWithCustomError(service, "InvalidStatus");
    });
  });

  /* ============================================================
     ORDER SERVICE — AUTO-COMPLETE
     ============================================================ */

  describe("OrderService — auto-complete", function () {
    beforeEach(async function () {
      await registry.addCourier(courier1.address);
      await service.connect(client1).createOrder("Pasta", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
    });

    it("reverts if confirm window has not passed", async function () {
      await expect(service.autoComplete(0))
        .to.be.revertedWithCustomError(service, "WithdrawTooEarly");
    });

    it("auto-completes after 2-day window with 5-star default", async function () {
      await time.increase(TWO_DAYS + 1);

      const fee = ETH1 * 500n / 10000n;
      const payout = ETH1 - fee;

      await expect(service.autoComplete(0))
        .to.emit(service, "OrderCompleted")
        .withArgs(0, payout);

      expect(await service.courierBalance(courier1.address)).to.equal(payout);

      // rating should be 5
      expect(await registry.averageRating(1)).to.equal(500);
    });
  });

  /* ============================================================
     ORDER SERVICE — WEEKLY WITHDRAWAL
     ============================================================ */

  describe("OrderService — weekly withdrawal", function () {
    beforeEach(async function () {
      await registry.addCourier(courier1.address);

      // complete 2 orders to build up balance
      await service.connect(client1).createOrder("Order A", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
      await service.connect(client1).confirmDelivery(0, 4);

      await service.connect(client2).createOrder("Order B", { value: ETH2 });
      await service.connect(courier1).pickUpOrder(1);
      await service.connect(courier1).markDelivered(1);
      await service.connect(client2).confirmDelivery(1, 5);
    });

    it("courier can withdraw accumulated balance", async function () {
      const expectedBal =
        (ETH1 * 9500n) / 10000n + (ETH2 * 9500n) / 10000n;
      expect(await service.courierBalance(courier1.address)).to.equal(expectedBal);

      const balBefore = await ethers.provider.getBalance(courier1.address);

      const tx = await service.connect(courier1).withdraw();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const balAfter = await ethers.provider.getBalance(courier1.address);
      expect(balAfter + gasCost - balBefore).to.equal(expectedBal);

      expect(await service.courierBalance(courier1.address)).to.equal(0);
    });

    it("cannot withdraw twice within 7 days", async function () {
      await service.connect(courier1).withdraw();

      // earn more
      await service.connect(client1).createOrder("C", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(2);
      await service.connect(courier1).markDelivered(2);
      await service.connect(client1).confirmDelivery(2, 5);

      await expect(service.connect(courier1).withdraw())
        .to.be.revertedWithCustomError(service, "WithdrawTooEarly");
    });

    it("can withdraw again after 7 days", async function () {
      await service.connect(courier1).withdraw();

      // earn more
      await service.connect(client1).createOrder("D", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(2);
      await service.connect(courier1).markDelivered(2);
      await service.connect(client1).confirmDelivery(2, 5);

      await time.increase(WEEK + 1);

      await expect(service.connect(courier1).withdraw())
        .to.emit(service, "Withdrawal");
    });

    it("inactive courier cannot withdraw", async function () {
      await registry.removeCourier(courier1.address);
      await expect(service.connect(courier1).withdraw())
        .to.be.revertedWithCustomError(service, "NotActiveCourier");
    });
  });

  /* ============================================================
     ORDER SERVICE — PLATFORM FEES
     ============================================================ */

  describe("OrderService — platform fees", function () {
    it("admin withdraws accumulated fees", async function () {
      await registry.addCourier(courier1.address);
      await service.connect(client1).createOrder("Fee test", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
      await service.connect(client1).confirmDelivery(0, 5);

      const expectedFee = ETH1 * 500n / 10000n;
      expect(await service.platformFees()).to.equal(expectedFee);

      const balBefore = await ethers.provider.getBalance(admin.address);
      const tx = await service.withdrawFees();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balAfter = await ethers.provider.getBalance(admin.address);

      expect(balAfter + gasCost - balBefore).to.equal(expectedFee);
      expect(await service.platformFees()).to.equal(0);
    });

    it("non-admin cannot withdraw fees", async function () {
      await expect(service.connect(client1).withdrawFees())
        .to.be.revertedWithCustomError(service, "OnlyAdmin");
    });
  });

  /* ============================================================
     ACCESS CONTROL EDGE CASES
     ============================================================ */

  describe("Access control edge cases", function () {
    beforeEach(async function () {
      await registry.addCourier(courier1.address);
      await service.connect(client1).createOrder("Edge", { value: ETH1 });
    });

    it("non-courier cannot pick up order", async function () {
      await expect(service.connect(client1).pickUpOrder(0))
        .to.be.revertedWithCustomError(service, "NotActiveCourier");
    });

    it("wrong courier cannot mark delivered", async function () {
      await registry.addCourier(courier2.address);
      await service.connect(courier1).pickUpOrder(0);
      await expect(service.connect(courier2).markDelivered(0))
        .to.be.revertedWithCustomError(service, "OnlyCourier");
    });

    it("wrong client cannot confirm delivery", async function () {
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
      await expect(service.connect(client2).confirmDelivery(0, 5))
        .to.be.revertedWithCustomError(service, "OnlyClient");
    });

    it("deactivated courier cannot pick up new orders", async function () {
      await registry.removeCourier(courier1.address);
      await expect(service.connect(courier1).pickUpOrder(0))
        .to.be.revertedWithCustomError(service, "NotActiveCourier");
    });
  });
});
