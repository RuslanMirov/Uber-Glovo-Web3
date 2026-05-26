const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // 1. Deploy CourierRegistry
  const Registry = await ethers.getContractFactory("CourierRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("CourierRegistry deployed to:", registryAddr);

  // 2. Deploy OrderService
  const Service = await ethers.getContractFactory("OrderService");
  const service = await Service.deploy(registryAddr);
  await service.waitForDeployment();
  const serviceAddr = await service.getAddress();
  console.log("OrderService  deployed to:", serviceAddr);

  // 3. Summary
  console.log("\n─── Deployment Summary ───");
  console.log(`  Admin:           ${deployer.address}`);
  console.log(`  CourierRegistry: ${registryAddr}`);
  console.log(`  OrderService:    ${serviceAddr}`);
  console.log(`  Platform Fee:    5%`);
  console.log(`  Confirm Window:  2 days`);
  console.log(`  Withdraw CD:     7 days`);
  console.log("──────────────────────────\n");

  return { registryAddr, serviceAddr };
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
