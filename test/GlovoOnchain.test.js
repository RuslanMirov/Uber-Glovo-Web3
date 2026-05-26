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
      await registry.addRating(1, 5);
      await registry.addRating(1, 3);
      expect(await registry.averageRating(1)).to.equal(400); // 4.00
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
     HAPPY PATH — courier delivers, no dispute, finalize after 2 days
     ============================================================ */

  describe("Happy path — auto-finalize", function () {
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

    it("full lifecycle: create → pickup → deliver → wait 2 days → finalize", async function () {
      await service.connect(client1).createOrder("Sushi", { value: ETH1 });

      // pickup
      await expect(service.connect(courier1).pickUpOrder(0))
        .to.emit(service, "OrderPickedUp")
        .withArgs(0, courier1.address);

      // deliver — starts dispute window
      await expect(service.connect(courier1).markDelivered(0))
        .to.emit(service, "OrderDelivered");

      // cannot finalize before 2 days
      await expect(service.finalizeOrder(0))
        .to.be.revertedWithCustomError(service, "TooEarly");

      // wait 2 days
      await time.increase(TWO_DAYS + 1);

      // finalize — money goes to courier
      const fee = ETH1 * 500n / 10000n;
      const payout = ETH1 - fee;

      await expect(service.finalizeOrder(0))
        .to.emit(service, "OrderFinalized")
        .withArgs(0, payout);

      expect(await service.courierBalance(courier1.address)).to.equal(payout);
      expect(await service.platformFees()).to.equal(fee);

      // courier NFT stats updated
      const info = await registry.couriers(1);
      expect(info.ordersCount).to.equal(1);
    });

    it("anyone can call finalize (not just courier)", async function () {
      await service.connect(client1).createOrder("Tacos", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
      await time.increase(TWO_DAYS + 1);

      // random address finalizes
      await expect(service.connect(client2).finalizeOrder(0))
        .to.emit(service, "OrderFinalized");
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
     CLIENT RATING (optional, does not block finalization)
     ============================================================ */

  describe("Client rating", function () {
    beforeEach(async function () {
      await registry.addCourier(courier1.address);
      await service.connect(client1).createOrder("Burger", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
    });

    it("client can rate during dispute window (Delivered status)", async function () {
      await expect(service.connect(client1).rateOrder(0, 4))
        .to.emit(service, "OrderRated")
        .withArgs(0, 4);

      expect(await service.orderRating(0)).to.equal(4);
      expect(await registry.averageRating(1)).to.equal(400); // 4.00
    });

    it("client can rate after finalization (Completed status)", async function () {
      await time.increase(TWO_DAYS + 1);
      await service.finalizeOrder(0);

      await expect(service.connect(client1).rateOrder(0, 3))
        .to.emit(service, "OrderRated")
        .withArgs(0, 3);

      expect(await registry.averageRating(1)).to.equal(300);
    });

    it("cannot rate twice", async function () {
      await service.connect(client1).rateOrder(0, 5);
      await expect(service.connect(client1).rateOrder(0, 3))
        .to.be.revertedWithCustomError(service, "AlreadyRated");
    });

    it("rejects invalid rating score", async function () {
      await expect(service.connect(client1).rateOrder(0, 0))
        .to.be.revertedWithCustomError(service, "InvalidRating");
      await expect(service.connect(client1).rateOrder(0, 6))
        .to.be.revertedWithCustomError(service, "InvalidRating");
    });

    it("only client can rate", async function () {
      await expect(service.connect(client2).rateOrder(0, 5))
        .to.be.revertedWithCustomError(service, "OnlyClient");
    });

    it("rating does not block finalization", async function () {
      await service.connect(client1).rateOrder(0, 2);

      await time.increase(TWO_DAYS + 1);

      // finalize still works
      await expect(service.finalizeOrder(0))
        .to.emit(service, "OrderFinalized");
    });
  });

  /* ============================================================
     DISPUTES — client complains within 2-day window
     ============================================================ */

  describe("Disputes", function () {
    beforeEach(async function () {
      await registry.addCourier(courier1.address);
      await service.connect(client1).createOrder("Cold food", { value: ETH2 });
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
    });

    it("client can dispute within 2-day window", async function () {
      await expect(service.connect(client1).disputeOrder(0))
        .to.emit(service, "OrderDisputed")
        .withArgs(0, client1.address);

      const o = await service.getOrder(0);
      expect(o.status).to.equal(4); // Disputed
    });

    it("client CANNOT dispute after 2-day window expires", async function () {
      await time.increase(TWO_DAYS + 1);
      await expect(service.connect(client1).disputeOrder(0))
        .to.be.revertedWithCustomError(service, "TooLate");
    });

    it("admin freezes disputed order", async function () {
      await service.connect(client1).disputeOrder(0);
      await expect(service.freezeOrder(0))
        .to.emit(service, "OrderFrozen")
        .withArgs(0);
    });

    it("admin resolves with refund to client", async function () {
      await service.connect(client1).disputeOrder(0);
      await service.freezeOrder(0);

      const balBefore = await ethers.provider.getBalance(client1.address);
      await expect(service.resolveDispute(0, true))
        .to.emit(service, "OrderRefunded")
        .withArgs(0, client1.address, ETH2);

      const balAfter = await ethers.provider.getBalance(client1.address);
      expect(balAfter - balBefore).to.equal(ETH2);

      const o = await service.getOrder(0);
      expect(o.status).to.equal(6); // Refunded
    });

    it("admin resolves in courier's favor", async function () {
      await service.connect(client1).disputeOrder(0);
      await service.freezeOrder(0);

      const fee = ETH2 * 500n / 10000n;
      const payout = ETH2 - fee;

      await expect(service.resolveDispute(0, false))
        .to.emit(service, "OrderFinalized")
        .withArgs(0, payout);

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
      await service.connect(client1).createOrder("test", { value: ETH1 });
      await expect(service.connect(client1).disputeOrder(1))
        .to.be.revertedWithCustomError(service, "InvalidStatus");
    });

    it("cannot finalize a disputed order", async function () {
      await service.connect(client1).disputeOrder(0);
      await time.increase(TWO_DAYS + 1);
      await expect(service.finalizeOrder(0))
        .to.be.revertedWithCustomError(service, "InvalidStatus");
    });
  });

  /* ============================================================
     WEEKLY WITHDRAWAL
     ============================================================ */

  describe("Weekly withdrawal", function () {
    beforeEach(async function () {
      await registry.addCourier(courier1.address);

      // complete 2 orders (deliver + wait + finalize)
      await service.connect(client1).createOrder("Order A", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);

      await service.connect(client2).createOrder("Order B", { value: ETH2 });
      await service.connect(courier1).pickUpOrder(1);
      await service.connect(courier1).markDelivered(1);

      await time.increase(TWO_DAYS + 1);

      await service.finalizeOrder(0);
      await service.finalizeOrder(1);
    });

    it("courier can withdraw accumulated balance", async function () {
      const expectedBal = (ETH1 * 9500n) / 10000n + (ETH2 * 9500n) / 10000n;
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
      await time.increase(TWO_DAYS + 1);
      await service.finalizeOrder(2);

      await expect(service.connect(courier1).withdraw())
        .to.be.revertedWithCustomError(service, "TooEarly");
    });

    it("can withdraw again after 7 days", async function () {
      await service.connect(courier1).withdraw();

      await service.connect(client1).createOrder("D", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(2);
      await service.connect(courier1).markDelivered(2);
      await time.increase(TWO_DAYS + 1);
      await service.finalizeOrder(2);

      await time.increase(WEEK);

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
     PLATFORM FEES
     ============================================================ */

  describe("Platform fees", function () {
    it("admin withdraws accumulated fees", async function () {
      await registry.addCourier(courier1.address);
      await service.connect(client1).createOrder("Fee test", { value: ETH1 });
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
      await time.increase(TWO_DAYS + 1);
      await service.finalizeOrder(0);

      const expectedFee = ETH1 * 500n / 10000n;
      expect(await service.platformFees()).to.equal(expectedFee);

      const balBefore = await ethers.provider.getBalance(admin.address);
      const tx = await service.withdrawFees();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balAfter = await ethers.provider.getBalance(admin.address);

      expect(balAfter + gasCost - balBefore).to.equal(expectedFee);
    });

    it("non-admin cannot withdraw fees", async function () {
      await expect(service.connect(client1).withdrawFees())
        .to.be.revertedWithCustomError(service, "OnlyAdmin");
    });
  });

  /* ============================================================
     ACCESS CONTROL EDGE CASES
     ============================================================ */

  describe("Access control", function () {
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

    it("wrong client cannot dispute", async function () {
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);
      await expect(service.connect(client2).disputeOrder(0))
        .to.be.revertedWithCustomError(service, "OnlyClient");
    });

    it("deactivated courier cannot pick up new orders", async function () {
      await registry.removeCourier(courier1.address);
      await expect(service.connect(courier1).pickUpOrder(0))
        .to.be.revertedWithCustomError(service, "NotActiveCourier");
    });

    it("disputeDeadline view returns correct timestamp", async function () {
      await service.connect(courier1).pickUpOrder(0);
      await service.connect(courier1).markDelivered(0);

      const o = await service.getOrder(0);
      const deadline = await service.disputeDeadline(0);
      expect(deadline).to.equal(o.deliveredAt + BigInt(TWO_DAYS));
    });
  });
});
