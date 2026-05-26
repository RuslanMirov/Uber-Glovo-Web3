const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function main() {
  const [admin, courier, client] = await ethers.getSigners();
  const fmt = ethers.formatEther;
  const TWO_DAYS = 2 * 24 * 3600;

  console.log("╔═══════════════════════════════════════╗");
  console.log("║      GLOVO ONCHAIN — DEMO FLOW        ║");
  console.log("╚═══════════════════════════════════════╝\n");

  const Registry = await ethers.getContractFactory("CourierRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();

  const Service = await ethers.getContractFactory("OrderService");
  const service = await Service.deploy(await registry.getAddress());
  await service.waitForDeployment();
  console.log("✓ Contracts deployed\n");

  // Register courier
  await (await registry.addCourier(courier.address)).wait();
  console.log(`✓ Courier registered → NFT #${await registry.courierToken(courier.address)}\n`);

  // ── Happy path: no dispute ──
  console.log("── HAPPY PATH ──");
  await (await service.connect(client).createOrder("2x Margherita + Coke", { value: ethers.parseEther("0.5") })).wait();
  console.log("✓ Order #0 created (0.5 ETH)");

  await (await service.connect(courier).pickUpOrder(0)).wait();
  console.log("✓ Courier picked up");

  await (await service.connect(courier).markDelivered(0)).wait();
  const deadline = await service.disputeDeadline(0);
  console.log(`✓ Courier marked done — dispute window open until block ts ${deadline}`);

  // Client rates (optional, doesn't block)
  await (await service.connect(client).rateOrder(0, 5)).wait();
  console.log("✓ Client rated ⭐ 5/5");

  // Wait 2 days — no dispute
  await time.increase(TWO_DAYS + 1);
  console.log("  ⏳ 2 days passed, no dispute...");

  await (await service.finalizeOrder(0)).wait();
  const bal = await service.courierBalance(courier.address);
  console.log(`✓ Finalized! Courier balance: ${fmt(bal)} ETH (after 5% fee)\n`);

  // ── Dispute path ──
  console.log("── DISPUTE PATH ──");
  await (await service.connect(client).createOrder("Cold sushi :(", { value: ethers.parseEther("0.3") })).wait();
  await (await service.connect(courier).pickUpOrder(1)).wait();
  await (await service.connect(courier).markDelivered(1)).wait();
  console.log("✓ Order #1 delivered");

  await (await service.connect(client).disputeOrder(1)).wait();
  console.log("✓ Client disputed within 2-day window");

  await (await service.freezeOrder(1)).wait();
  console.log("✓ Admin froze order");

  const clientBefore = await ethers.provider.getBalance(client.address);
  await (await service.resolveDispute(1, true)).wait();
  const clientAfter = await ethers.provider.getBalance(client.address);
  console.log(`✓ Admin refunded client: +${fmt(clientAfter - clientBefore)} ETH\n`);

  // ── Courier withdrawal ──
  console.log("── COURIER WITHDRAWAL ──");
  const courierBefore = await ethers.provider.getBalance(courier.address);
  const tx = await service.connect(courier).withdraw();
  const receipt = await tx.wait();
  const gas = receipt.gasUsed * receipt.gasPrice;
  const courierAfter = await ethers.provider.getBalance(courier.address);
  console.log(`✓ Courier withdrew: ${fmt(courierAfter + gas - courierBefore)} ETH`);

  // Stats
  const tokenId = await registry.courierToken(courier.address);
  const info = await registry.couriers(tokenId);
  const avg = await registry.averageRating(tokenId);
  console.log(`\n── Courier NFT #${tokenId} ──`);
  console.log(`  Orders: ${info.ordersCount} | Rating: ${Number(avg)/100}/5.00 | Active: ${info.active}`);

  console.log("\n✅ Demo complete!");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
