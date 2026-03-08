import { task, types } from "hardhat/config";
import { ethers } from "ethers";

// ================================================================
//  register-event
// ================================================================
task("register-event", "Register a new disaster event and commit per-tier payout amounts atomically")
  .addParam("contract", "ReliefTreasury address")
  .addParam("eventid", "Event ID (hex bytes32, or string that will be hashed)")
  .addParam("cap", "Per-event USDC cap (6 decimals, e.g. 5000000000 = $5000)")
  .addParam("tiers", "Comma-separated tier numbers, e.g. 1,2")
  .addParam("amounts", "Comma-separated raw USDC amounts per tier (6 dec), e.g. 50000000,100000000")
  .addParam("claimwindow", "Claim window in days (1–365). Admin cannot close a verified event until this many days after activation.", "90", types.string, true)
  .setAction(async ({ contract, eventid, cap, tiers, amounts, claimwindow }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);

    const eventId = eventid.startsWith("0x")
      ? eventid
      : hre.ethers.keccak256(hre.ethers.toUtf8Bytes(eventid));

    const tierArr      = (tiers as string).split(",").map((t: string) => parseInt(t.trim(), 10));
    const amountArr    = (amounts as string).split(",").map((a: string) => BigInt(a.trim()));
    const claimWindowDays = parseInt(claimwindow as string, 10);

    if (tierArr.length !== amountArr.length) {
      console.error("Error: tiers and amounts must have the same number of entries");
      process.exit(1);
    }
    if (claimWindowDays < 1 || claimWindowDays > 365) {
      console.error("Error: --claimwindow must be between 1 and 365 days");
      process.exit(1);
    }

    console.log(`Registering event ${eventId}:`);
    console.log(`  Per-event cap:  $${Number(cap) / 1e6} USDC`);
    console.log(`  Claim window:   ${claimWindowDays} days from activation`);
    tierArr.forEach((t: number, i: number) =>
      console.log(`  Tier ${t}: $${Number(amountArr[i]) / 1e6} USDC`)
    );

    const tx = await (relief as any).registerEvent(eventId, BigInt(cap), tierArr, amountArr, claimWindowDays);
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
//  NOTE: There is no activate-event task.
//
//  Events auto-activate inside onReport() when CRE Pipeline 1
//  returns verified=true. The contract emits EventVerified and
//  EventActivated in the same transaction. There is no manual
//  activateEvent() function and no separate Verified→Active step.
// ================================================================

// ================================================================
//  anchor-roster
// ================================================================
task("anchor-roster", "Anchor a processed roster's SHA-256 hash onchain for public auditability")
  .addParam("contract", "ReliefTreasury address")
  .addParam("rosterhash", "SHA-256 hash of the original CSV (hex bytes32)")
  .addParam("eventid", "Event ID (hex bytes32)")
  .addParam("program", "Program identifier, e.g. US-FLOOD-2026")
  .addParam("region", "Region identifier, e.g. US-CA")
  .setAction(async ({ contract, rosterhash, eventid, program, region }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);

    console.log(`Anchoring roster hash ${rosterhash.slice(0, 10)}... for event ${eventid.slice(0, 10)}...`);
    console.log(`  Program: ${program}`);
    console.log(`  Region:  ${region}`);

    const tx = await (relief as any).anchorRoster(rosterhash, eventid, program, region);
    const receipt = await tx.wait();
    console.log(`✅ Roster anchored. Anyone can verify by hashing the original CSV and comparing.`);
    console.log(`   Tx: ${receipt.hash}`);
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
    const token = await hre.ethers.getContractAt("IERC20", usdc, signer);
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);

    console.log(`Approving ${Number(amount) / 1e6} USDC for deposit...`);
    const approveTx = await (token as any).approve(contract, BigInt(amount));
    await approveTx.wait();

    const depositTx = await (relief as any).deposit(BigInt(amount));
    const receipt = await depositTx.wait();
    console.log(`✅ Deposited $${Number(amount) / 1e6} USDC. Tx: ${receipt.hash}`);
  });

// ================================================================
//  request-eligibility
// ================================================================
task("request-eligibility", "Submit a candidate eligibility batch to CRE for OPA validation (CRE Pipeline 2)")
  .addParam("contract", "ReliefTreasury address")
  .addParam("eventid", "Event ID (hex bytes32)")
  .addParam("recipients", "Comma-separated wallet addresses")
  .addParam("tiers", "Comma-separated tier numbers matching recipients, e.g. 1,1,2")
  .setAction(async ({ contract, eventid, recipients, tiers }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);

    const recipientArr = (recipients as string).split(",").map((a: string) => a.trim());
    const tierArr      = (tiers as string).split(",").map((t: string) => parseInt(t.trim(), 10));

    if (recipientArr.length !== tierArr.length) {
      console.error("Error: recipients and tiers must have the same number of entries");
      process.exit(1);
    }

    console.log(`Requesting eligibility registration for event ${eventid}:`);
    console.log(`  Candidates: ${recipientArr.length}`);
    recipientArr.forEach((addr: string, i: number) =>
      console.log(`  ${addr} → tier ${tierArr[i]}`)
    );

    const tx = await (relief as any).requestEligibilityRegistration(eventid, recipientArr, tierArr);
    const receipt = await tx.wait();

    const iface = (relief as any).interface;
    const requestSentLog = receipt.logs
      .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
      .find((l: any) => l?.name === "RequestSent");

    if (requestSentLog) {
      console.log(`✅ Eligibility registration requested. CRE will validate via OPA and write onchain.`);
      console.log(`   requestId: ${requestSentLog.args.requestId}`);
      console.log(`   Tx: ${receipt.hash}`);
    } else {
      console.log(`✅ Tx: ${receipt.hash}`);
    }
  });

// ================================================================
//  claim-disbursement
// ================================================================
task("claim-disbursement", "Claim disbursement (synchronous — requires CRE eligibility to be set onchain first)")
  .addParam("contract", "ReliefTreasury address")
  .addParam("eventid", "Event ID (hex bytes32)")
  .setAction(async ({ contract, eventid }, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const relief = await hre.ethers.getContractAt("ReliefTreasury", contract, signer);

    // Check eligibility before attempting claim
    const tier: bigint = await (relief as any).getEligibilityTier(eventid, signer.address);
    if (tier === 0n) {
      console.error(`❌ Not eligible: ${signer.address} has no CRE-written eligibility for event ${eventid}`);
      console.error(`   Run 'request-eligibility' first to have CRE register eligibility onchain.`);
      process.exit(1);
    }

    console.log(`Claiming disbursement for event ${eventid} (tier ${tier})...`);
    const tx = await (relief as any).claimDisbursement(eventid);
    const receipt = await tx.wait();

    const iface = (relief as any).interface;
    const disbursedLog = receipt.logs
      .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
      .find((l: any) => l?.name === "Disbursed");

    if (disbursedLog) {
      const amount = disbursedLog.args.amount as bigint;
      console.log(`✅ Disbursement complete: $${Number(amount) / 1e6} USDC transferred.`);
      console.log(`   Tx: ${receipt.hash}`);
    } else {
      console.log(`   Tx: ${receipt.hash}`);
    }
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
    const programCap = await (relief as any).programCap();

    console.log("=".repeat(50));
    console.log("ReliefTreasury Status");
    console.log("=".repeat(50));
    console.log(`Address:           ${contract}`);
    console.log(`Network:           ${hre.network.name}`);
    console.log(`Available Funds:   $${Number(available) / 1e6} USDC`);
    console.log(`Total Deposited:   $${Number(totalDeposited) / 1e6} USDC`);
    console.log(`Total Disbursed:   $${Number(totalDisbursed) / 1e6} USDC`);
    console.log(`Program Cap:   $${Number(programCap) / 1e6} USDC`);
    console.log(`Remaining Cap: $${Number(remaining) / 1e6} USDC`);

    if (eventid) {
      const ev = await (relief as any).getEventRecord(eventid);
      const statuses = ["Unregistered", "Pending", "Verified", "Active", "Closed"];
      console.log("─".repeat(50));
      console.log(`Event ${eventid.slice(0, 10)}...`);
      console.log(`  Status:          ${statuses[Number(ev.status)]}`);
      console.log(`  Per-event cap:   $${Number(ev.perEventCap) / 1e6}`);
      console.log(`  Disbursed:       $${Number(ev.totalDisbursed) / 1e6}`);

      // Print per-event tier amounts (tiers 1–5)
      const tierAmounts: string[] = [];
      for (let t = 1; t <= 5; t++) {
        const amt: bigint = await (relief as any).getEventTierAmount(eventid, t);
        if (amt > 0n) tierAmounts.push(`Tier ${t}: $${Number(amt) / 1e6} USDC`);
      }
      if (tierAmounts.length > 0) {
        console.log(`  Tier amounts:`);
        tierAmounts.forEach((line) => console.log(`    ${line}`));
      }
    }
    console.log("=".repeat(50));
  });
