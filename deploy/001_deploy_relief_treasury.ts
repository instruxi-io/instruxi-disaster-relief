import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log("\n🏦  Deploying ReliefTreasury...\n");

  // ── USDC Address ────────────────────────────────────────────────
  let usdcAddress: string;
  if (network.name === "localhost" || network.name === "hardhat") {
    const mockUSDC = await get("MockUSDC");
    usdcAddress = mockUSDC.address;
    console.log(`Using MockUSDC at: ${usdcAddress}`);
  } else {
    usdcAddress = process.env.USDC_ADDRESS || "";
    if (!usdcAddress) throw new Error("USDC_ADDRESS env var required for non-local networks");
    console.log(`Using USDC at: ${usdcAddress}`);
  }

  // ── Deployment Parameters ────────────────────────────────────────
  // $1,000,000 USDC program cap
  const programCap = BigInt(process.env.PROGRAM_CAP || "1000000000000");
  const admin = process.env.ADMIN_ADDRESS || deployer;

  console.log(`Program cap: $${Number(programCap) / 1e6} USDC`);
  console.log(`Admin:       ${admin}`);

  // ── Deploy ───────────────────────────────────────────────────────
  const relief = await deploy("ReliefTreasury", {
    from: deployer,
    args: [usdcAddress, programCap, admin],
    log: true,
  });

  console.log(`\n✅ ReliefTreasury deployed at: ${relief.address}\n`);

  // ── Post-deploy: authorize Chainlink Forwarder ───────────────────
  const forwarder = process.env.CHAINLINK_FORWARDER_ADDRESS || "";
  if (forwarder && relief.newlyDeployed) {
    console.log(`🔗  Authorizing Chainlink Forwarder: ${forwarder}`);
    const ethers = hre.ethers;
    const signer = await ethers.getSigner(deployer);
    const contract = await ethers.getContractAt("ReliefTreasury", relief.address, signer);
    const tx = await (contract as any).setFulfillerAuthorization(forwarder, true);
    await tx.wait();
    console.log(`✅  Forwarder authorized`);
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log("=".repeat(55));
  console.log("Deployment Summary");
  console.log("=".repeat(55));
  console.log(`Network:           ${network.name}`);
  console.log(`ReliefTreasury: ${relief.address}`);
  console.log(`USDC:           ${usdcAddress}`);
  console.log(`Program cap:    $${Number(programCap) / 1e6}`);
  console.log(`Admin:             ${admin}`);
  if (forwarder) console.log(`CRE Forwarder:     ${forwarder} (authorized)`);
  console.log("=".repeat(55));
};

export default func;
func.tags = ["ReliefTreasury"];
func.dependencies = ["Mocks"];
