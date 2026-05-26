const { ethers } = require("hardhat");

/**
 * Demonstrates the full Glovo Onchain lifecycle on a local Hardhat node.
 * Run:  npx hardhat run scripts/demo.js
 */
async function main() {
  const [admin, courier, client] = await ethers.getSigners();
  const fmt = ethers.formatEther;

  console.log("╔═══════════════════════════════════════╗");
  console.log("║      GLOVO ONCHAIN — DEMO FLOW        ║");
  console.log("╚═══════════════════════════════════════╝\n");

  // ── Deploy ──
  const Registry = await ethers.getContractFactory("CourierRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();

  const Service = await ethers.getContractFactory("OrderService");
  const service = await Service.deploy(await registry.getAddress());
  await service.waitForDeployment();

  console.log("✓ Contracts deployed\n");

  // ── Register courier ──
  const tx1 = await registry.connect(admin).addCourier(courier.address);
  await tx1.wait();
  console.log(`✓ Courier registered  →  NFT #${await registry.courierToken(courier.address)}`);
  console.log(`  Address: ${courier.address}\n`);

  // ── Client places order ──
  const orderValue = ethers.parseEther("0.5");
  const tx2 = await service.connect(client).createOrder("2x Margherita Pizza + Coke", { value: orderValue });
  await tx2.wait();
  console.log(`✓ Order #0 created by client`);
  console.log(`  Payment: ${fmt(orderValue)} ETH`);
  console.log(`  Details: "2x Margherita Pizza + Coke"\n`);

  // ── Courier picks up ──
  const tx3 = await service.connect(courier).pickUpOrder(0);
  await tx3.wait();
  console.log("✓ Courier picked up order #0\n");

  // ── Courier delivers ──
  const tx4 = await service.connect(courier).markDelivered(0);
  await tx4.wait();
  console.log("✓ Courier marked order #0 as delivered\n");

  // ── Client confirms with 5-star rating ──
  const tx5 = await service.connect(client).confirmDelivery(0, 5);
  await tx5.wait();

  const courierBal = await service.courierBalance(courier.address);
  const platformFees = await service.platformFees();
  console.log("✓ Client confirmed delivery (⭐ 5/5)");
  console.log(`  Courier balance:  ${fmt(courierBal)} ETH`);
  console.log(`  Platform fees:    ${fmt(platformFees)} ETH\n`);

  // ── Courier stats ──
  const tokenId = await registry.courierToken(courier.address);
  const info = await registry.couriers(tokenId);
  const avg = await registry.averageRating(tokenId);
  console.log("── Courier NFT Stats ──");
  console.log(`  Orders completed: ${info.ordersCount}`);
  console.log(`  Average rating:   ${Number(avg) / 100}/5.00`);
  console.log(`  Active:           ${info.active}\n`);

  // ── Courier withdraws ──
  const balBefore = await ethers.provider.getBalance(courier.address);
  const tx6 = await service.connect(courier).withdraw();
  const receipt = await tx6.wait();
  const balAfter = await ethers.provider.getBalance(courier.address);
  const gasCost = receipt.gasUsed * receipt.gasPrice;

  console.log("✓ Courier withdrew earnings");
  console.log(`  Net received: ${fmt(balAfter + gasCost - balBefore)} ETH`);
  console.log(`  Gas cost:     ${fmt(gasCost)} ETH\n`);

  // ── Dispute flow demo ──
  console.log("── Dispute Flow ──");
  const tx7 = await service.connect(client).createOrder("Cold sushi :(", { value: ethers.parseEther("0.3") });
  await tx7.wait();
  await (await service.connect(courier).pickUpOrder(1)).wait();
  await (await service.connect(courier).markDelivered(1)).wait();

  await (await service.connect(client).disputeOrder(1)).wait();
  console.log("✓ Client disputed order #1");

  await (await service.connect(admin).freezeOrder(1)).wait();
  console.log("✓ Admin froze order #1");

  const clientBalBefore = await ethers.provider.getBalance(client.address);
  await (await service.connect(admin).resolveDispute(1, true)).wait();
  const clientBalAfter = await ethers.provider.getBalance(client.address);
  console.log(`✓ Admin refunded client: +${fmt(clientBalAfter - clientBalBefore)} ETH\n`);

  const order1 = await service.getOrder(1);
  console.log(`  Order #1 final status: ${["Created","PickedUp","Delivered","Completed","Disputed","Frozen","Refunded","Cancelled"][Number(order1.status)]}`);

  console.log("\n✅ Demo complete!");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
