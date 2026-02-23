import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // Only deploy mocks on local networks
  if (network.name !== "localhost" && network.name !== "hardhat") {
    console.log("Skipping mock deployment on", network.name);
    return;
  }

  console.log("\n🪙  Deploying MockUSDC...\n");

  const mockUSDC = await deploy("MockUSDC", {
    from: deployer,
    args: [],
    log: true,
  });

  console.log(`✅ MockUSDC deployed at: ${mockUSDC.address}\n`);
};

export default func;
func.tags = ["Mocks", "MockUSDC"];
