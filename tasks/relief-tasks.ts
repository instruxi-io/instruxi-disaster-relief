import { task, types } from "hardhat/config";
import { ethers } from "ethers";

// ================================================================
//  register-event
// ================================================================
task("register-event", "Register a new disaster event in ReliefTreasury")
  .addParam("contract", "ReliefTreasury address")
  .addParam("eventid", "Event ID (hex bytes32, or string that will be hashed)")
  .addParam("cap", "Per-event USDC cap (6 decimals, e.g. 100000000 = $100)")
  .setAction(async ({ contract, eventid, cap }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);

    const eventId = eventid.startsWith("0x")
      ? eventid
      : hre.ethers.keccak256(hre.ethers.toUtf8Bytes(eventid));

    console.log(`Registering event ${eventId} with cap $${Number(cap) / 1e6} USDC...`);
    const tx = await (relief as any).registerEvent(eventId, BigInt(cap));
    const receipt = await tx.wait();
    console.log(`✅ Event registered. Tx: ${receipt.hash}`);
  });

// ================================================================
//  request-verification
// ================================================================
task("request-verification", "Request CRE event verification")
  .addParam("contract", "ReliefTreasury address")
  .addParam("eventid", "Event ID (hex bytes32)")
  .addParam("ref", "External reference JSON, e.g. {\"usgsId\":\"us7000abc\",\"region\":\"US\"}")
  .setAction(async ({ contract, eventid, ref }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);

    console.log(`Requesting verification for event ${eventid}...`);
    const tx = await (relief as any).requestEventVerification(eventid, ref);
    const receipt = await tx.wait();

    const iface = (relief as any).interface;
    const requestSentLog = receipt.logs
      .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
      .find((l: any) => l?.name === "RequestSent");

    if (requestSentLog) {
      console.log(`✅ Verification requested.`);
      console.log(`   requestId: ${requestSentLog.args.requestId}`);
      console.log(`   Tx: ${receipt.hash}`);
    } else {
      console.log(`✅ Tx: ${receipt.hash}`);
    }
  });

// ================================================================
//  activate-event
// ================================================================
task("activate-event", "Activate a verified event to enable disbursements")
  .addParam("contract", "ReliefTreasury address")
  .addParam("eventid", "Event ID (hex bytes32)")
  .setAction(async ({ contract, eventid }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);
    const tx = await (relief as any).activateEvent(eventid);
    const receipt = await tx.wait();
    console.log(`✅ Event ${eventid} activated. Tx: ${receipt.hash}`);
  });

// ================================================================
//  set-eligibility
// ================================================================
task("set-eligibility", "Manually set recipient eligibility (test use)")
  .addParam("contract", "ReliefTreasury address")
  .addParam("eventid", "Event ID (hex bytes32)")
  .addParam("recipient", "Recipient wallet address")
  .addParam("eligible", "true or false", "true", types.string)
  .setAction(async ({ contract, eventid, recipient, eligible }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);
    const isEligible = eligible === "true";
    const tx = await (relief as any).setEligibility(eventid, recipient, isEligible);
    const receipt = await tx.wait();
    console.log(`✅ Eligibility set to ${isEligible} for ${recipient}. Tx: ${receipt.hash}`);
  });

// ================================================================
//  deposit-usdc
// ================================================================
task("deposit-usdc", "Deposit USDC into ReliefTreasury")
  .addParam("contract", "ReliefTreasury address")
  .addParam("usdc", "USDC token address")
  .addParam("amount", "Amount in 6-decimal units (e.g. 1000000000 = $1000)")
  .setAction(async ({ contract, usdc, amount }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const token = await hre.ethers.getContractAt("MockUSDC", usdc, signer);
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);

    console.log(`Approving ${Number(amount) / 1e6} USDC for deposit...`);
    const approveTx = await (token as any).approve(contract, BigInt(amount));
    await approveTx.wait();

    const depositTx = await (relief as any).deposit(BigInt(amount));
    const receipt = await depositTx.wait();
    console.log(`✅ Deposited $${Number(amount) / 1e6} USDC. Tx: ${receipt.hash}`);
  });

// ================================================================
//  claim-disbursement
// ================================================================
task("claim-disbursement", "Submit a disbursement claim as a recipient")
  .addParam("contract", "ReliefTreasury address")
  .addParam("eventid", "Event ID (hex bytes32)")
  .setAction(async ({ contract, eventid }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);
    const tx = await (relief as any).claimDisbursement(eventid);
    const receipt = await tx.wait();

    const iface = (relief as any).interface;
    const requestSentLog = receipt.logs
      .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
      .find((l: any) => l?.name === "RequestSent");

    if (requestSentLog) {
      console.log(`✅ Claim submitted. CRE will process via onReport().`);
      console.log(`   requestId: ${requestSentLog.args.requestId}`);
    }
    console.log(`   Tx: ${receipt.hash}`);
  });

// ================================================================
//  treasury-status
// ================================================================
task("treasury-status", "Print ReliefTreasury status")
  .addParam("contract", "ReliefTreasury address")
  .addOptionalParam("eventid", "Event ID to query (hex bytes32)")
  .setAction(async ({ contract, eventid }, hre) => {
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract);

    const available = await (relief as any).availableFunds();
    const remaining = await (relief as any).remainingProgramCap();
    const totalDeposited = await (relief as any).totalDeposited();
    const totalDisbursed = await (relief as any).totalDisbursed();
    const perRecipientCap = await (relief as any).perRecipientCap();
    const programCap = await (relief as any).programCap();

    console.log("=".repeat(50));
    console.log("ReliefTreasury Status");
    console.log("=".repeat(50));
    console.log(`Address:           ${contract}`);
    console.log(`Network:           ${hre.network.name}`);
    console.log(`Available Funds:   $${Number(available) / 1e6} USDC`);
    console.log(`Total Deposited:   $${Number(totalDeposited) / 1e6} USDC`);
    console.log(`Total Disbursed:   $${Number(totalDisbursed) / 1e6} USDC`);
    console.log(`Program Cap:       $${Number(programCap) / 1e6} USDC`);
    console.log(`Remaining Cap:     $${Number(remaining) / 1e6} USDC`);
    console.log(`Per-Recipient Cap: $${Number(perRecipientCap) / 1e6} USDC`);

    if (eventid) {
      const ev = await (relief as any).getEventRecord(eventid);
      const statuses = ["Unregistered", "Pending", "Verified", "Active", "Closed"];
      console.log("─".repeat(50));
      console.log(`Event ${eventid.slice(0, 10)}...`);
      console.log(`  Status:          ${statuses[Number(ev.status)]}`);
      console.log(`  Per-event cap:   $${Number(ev.perEventCap) / 1e6}`);
      console.log(`  Disbursed:       $${Number(ev.totalDisbursed) / 1e6}`);
    }
    console.log("=".repeat(50));
  });
