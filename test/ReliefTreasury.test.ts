import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { MockUSDC, ReliefTreasury } from "../typechain-types";

// ── Helpers ─────────────────────────────────────────────────────────────────

const USDC = (n: number) => BigInt(n) * 1_000_000n; // 6 decimals

function encodeEventVerificationReport(requestId: string, verified: boolean): string {
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bool"],
    [requestId, verified]
  );
  return "0x01" + payload.slice(2);
}

/**
 * Encode an eligibility registration report: prefix 0x02 + abi.encode(requestId, address[], uint8[])
 * CRE calls this after OPA-validating the candidate batch and returns only approved recipients.
 */
function encodeEligibilityReport(
  requestId: string,
  recipients: string[],
  tiers: number[]
): string {
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address[]", "uint8[]"],
    [requestId, recipients, tiers]
  );
  return "0x02" + payload.slice(2);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function deployFixture() {
  const [deployer, admin, fulfiller, recipient, other] = await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = (await MockUSDC.deploy()) as unknown as MockUSDC;

  const PER_RECIPIENT_CAP = USDC(100);     // $100 ceiling
  const PROGRAM_CAP       = USDC(100_000); // $100,000

  const ReliefTreasury = await ethers.getContractFactory("ReliefTreasury");
  const treasury = (await ReliefTreasury.deploy(
    await usdc.getAddress(),
    PER_RECIPIENT_CAP,
    PROGRAM_CAP,
    admin.address
  )) as unknown as ReliefTreasury;

  await treasury.connect(admin).setFulfillerAuthorization(fulfiller.address, true);

  await usdc.mint(admin.address, USDC(100_000));
  await usdc.mint(recipient.address, USDC(1_000));
  await usdc.connect(admin).approve(await treasury.getAddress(), USDC(100_000));

  const EVENT_ID      = ethers.keccak256(ethers.toUtf8Bytes("US-FLOOD-2026-001"));
  const PER_EVENT_CAP = USDC(10_000);
  const TIERS         = [1, 2];
  const AMOUNTS       = [USDC(50), USDC(100)]; // tier 1=$50, tier 2=$100

  return {
    usdc, treasury, deployer, admin, fulfiller, recipient, other,
    EVENT_ID, PER_EVENT_CAP, PER_RECIPIENT_CAP, PROGRAM_CAP,
    TIERS, AMOUNTS,
  };
}

// Helper: extract requestId from RequestSent event in a tx receipt
async function extractRequestId(treasury: ReliefTreasury, tx: any): Promise<string> {
  const receipt = await tx.wait();
  const iface = treasury.interface;
  const log = receipt!.logs
    .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l: any) => l?.name === "RequestSent");
  return log!.args.requestId;
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe("ReliefTreasury", function () {
  // ── Deployment ──────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("stores immutable parameters correctly", async function () {
      const { treasury, usdc, PER_RECIPIENT_CAP, PROGRAM_CAP } = await deployFixture();
      expect(await treasury.usdc()).to.equal(await usdc.getAddress());
      expect(await treasury.perRecipientCap()).to.equal(PER_RECIPIENT_CAP);
      expect(await treasury.programCap()).to.equal(PROGRAM_CAP);
    });

    it("grants roles to admin", async function () {
      const { treasury, admin } = await deployFixture();
      const DEFAULT_ADMIN_ROLE = await treasury.DEFAULT_ADMIN_ROLE();
      const DEPOSITOR_ROLE     = await treasury.DEPOSITOR_ROLE();
      const PAUSER_ROLE        = await treasury.PAUSER_ROLE();
      expect(await treasury.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await treasury.hasRole(DEPOSITOR_ROLE, admin.address)).to.be.true;
      expect(await treasury.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
    });

    it("reverts on zero USDC address", async function () {
      const ReliefTreasury = await ethers.getContractFactory("ReliefTreasury");
      const [, admin] = await ethers.getSigners();
      await expect(
        ReliefTreasury.deploy(ethers.ZeroAddress, USDC(100), USDC(100_000), admin.address)
      ).to.be.revertedWith("ReliefTreasury: zero USDC address");
    });

    it("reverts when perRecipientCap > programCap", async function () {
      const ReliefTreasury = await ethers.getContractFactory("ReliefTreasury");
      const [, admin] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      await expect(
        ReliefTreasury.deploy(await usdc.getAddress(), USDC(1_000), USDC(50), admin.address)
      ).to.be.revertedWith("ReliefTreasury: cap inconsistency");
    });
  });

  // ── Funding ─────────────────────────────────────────────────────────────

  describe("Funding", function () {
    it("allows DEPOSITOR_ROLE to deposit USDC", async function () {
      const { treasury, usdc, admin } = await deployFixture();
      const amount = USDC(5_000);
      await expect(treasury.connect(admin).deposit(amount))
        .to.emit(treasury, "Deposited")
        .withArgs(admin.address, amount);
      expect(await treasury.totalDeposited()).to.equal(amount);
      expect(await treasury.availableFunds()).to.equal(amount);
    });

    it("reverts deposit for non-DEPOSITOR_ROLE", async function () {
      const { treasury, other } = await deployFixture();
      await expect(treasury.connect(other).deposit(USDC(100))).to.be.reverted;
    });

    it("reverts zero-amount deposit", async function () {
      const { treasury, admin } = await deployFixture();
      await expect(treasury.connect(admin).deposit(0n))
        .to.be.revertedWith("ReliefTreasury: zero amount");
    });
  });

  // ── Event Management ────────────────────────────────────────────────────

  describe("Event Management", function () {
    it("registers an event with tier amounts and emits EventRegistered", async function () {
      const { treasury, admin, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = await deployFixture();
      await expect(treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS))
        .to.emit(treasury, "EventRegistered")
        .withArgs(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);
      const ev = await treasury.getEventRecord(EVENT_ID);
      expect(ev.status).to.equal(1); // Pending
      expect(ev.perEventCap).to.equal(PER_EVENT_CAP);
      expect(await treasury.getEventTierAmount(EVENT_ID, 1)).to.equal(USDC(50));
      expect(await treasury.getEventTierAmount(EVENT_ID, 2)).to.equal(USDC(100));
    });

    it("reverts duplicate event registration", async function () {
      const { treasury, admin, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = await deployFixture();
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);
      await expect(
        treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS)
      ).to.be.revertedWithCustomError(treasury, "EventAlreadyRegistered");
    });

    it("reverts registerEvent if tier amount exceeds perRecipientCap", async function () {
      const { treasury, admin, EVENT_ID, PER_EVENT_CAP, PER_RECIPIENT_CAP } = await deployFixture();
      await expect(
        treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, [1], [PER_RECIPIENT_CAP + 1n])
      ).to.be.revertedWith("ReliefTreasury: tier amount exceeds perRecipientCap");
    });

    it("requests event verification and emits RequestSent", async function () {
      const { treasury, admin, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = await deployFixture();
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);
      const ref = JSON.stringify({ usgsId: "us7000abc", region: "US", minMagnitude: 5 });
      await expect(treasury.connect(admin).requestEventVerification(EVENT_ID, ref))
        .to.emit(treasury, "EventVerificationRequested")
        .to.emit(treasury, "RequestSent");
    });

    it("activates a verified event", async function () {
      const { treasury, admin, fulfiller, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = await deployFixture();
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);
      const ref = JSON.stringify({ usgsId: "us7000abc", region: "US" });
      const requestId = await extractRequestId(
        treasury,
        await treasury.connect(admin).requestEventVerification(EVENT_ID, ref)
      );

      await expect(
        treasury.connect(fulfiller).onReport("0x", encodeEventVerificationReport(requestId, true))
      ).to.emit(treasury, "EventVerified").withArgs(EVENT_ID);

      await expect(treasury.connect(admin).activateEvent(EVENT_ID))
        .to.emit(treasury, "EventActivated").withArgs(EVENT_ID);

      expect((await treasury.getEventRecord(EVENT_ID)).status).to.equal(3); // Active
    });

    it("closes an event", async function () {
      const { treasury, admin, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = await deployFixture();
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);
      await expect(treasury.connect(admin).closeEvent(EVENT_ID))
        .to.emit(treasury, "EventClosed").withArgs(EVENT_ID);
      expect((await treasury.getEventRecord(EVENT_ID)).status).to.equal(4); // Closed
    });
  });

  // ── Roster Transparency ──────────────────────────────────────────────────

  describe("Roster Transparency", function () {
    it("anchorRoster emits RosterAnchored with hash and event context", async function () {
      const { treasury, admin, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = await deployFixture();
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);

      // Simulates sha256 of a CSV file (truncated to bytes32 for the test)
      const rosterHash = ethers.keccak256(ethers.toUtf8Bytes("roster-csv-content-hash"));

      await expect(
        treasury.connect(admin).anchorRoster(rosterHash, EVENT_ID, "US-FLOOD-2026", "US-CA")
      )
        .to.emit(treasury, "RosterAnchored")
        .withArgs(rosterHash, EVENT_ID, "US-FLOOD-2026", "US-CA");
    });

    it("reverts anchorRoster if event not registered", async function () {
      const { treasury, admin, EVENT_ID } = await deployFixture();
      const rosterHash = ethers.keccak256(ethers.toUtf8Bytes("some-csv"));
      await expect(
        treasury.connect(admin).anchorRoster(rosterHash, EVENT_ID, "US-FLOOD-2026", "US-CA")
      ).to.be.revertedWithCustomError(treasury, "EventNotFound");
    });

    it("reverts anchorRoster from non-admin", async function () {
      const { treasury, admin, other, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = await deployFixture();
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);
      const rosterHash = ethers.keccak256(ethers.toUtf8Bytes("some-csv"));
      await expect(
        treasury.connect(other).anchorRoster(rosterHash, EVENT_ID, "US-FLOOD-2026", "US-CA")
      ).to.be.reverted;
    });
  });

  // ── Eligibility Registration (CRE) ──────────────────────────────────────

  describe("Eligibility Registration (CRE)", function () {
    async function registeredEventFixture() {
      const ctx = await deployFixture();
      const { treasury, admin, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = ctx;
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);
      return ctx;
    }

    it("requestEligibilityRegistration emits RequestSent and EligibilityRegistrationRequested", async function () {
      const { treasury, admin, fulfiller, recipient, EVENT_ID } = await registeredEventFixture();

      await expect(
        treasury.connect(admin).requestEligibilityRegistration(
          EVENT_ID, [recipient.address], [1]
        )
      )
        .to.emit(treasury, "EligibilityRegistrationRequested")
        .to.emit(treasury, "RequestSent");
    });

    it("CRE fulfiller writes eligibility onchain via onReport", async function () {
      const { treasury, admin, fulfiller, recipient, EVENT_ID } = await registeredEventFixture();

      const requestId = await extractRequestId(
        treasury,
        await treasury.connect(admin).requestEligibilityRegistration(
          EVENT_ID, [recipient.address], [1]
        )
      );

      await expect(
        treasury.connect(fulfiller).onReport(
          "0x",
          encodeEligibilityReport(requestId, [recipient.address], [1])
        )
      )
        .to.emit(treasury, "EligibilitySet")
        .withArgs(EVENT_ID, recipient.address, 1);

      expect(await treasury.getEligibilityTier(EVENT_ID, recipient.address)).to.equal(1);
    });

    it("CRE may approve a subset of the candidate batch (OPA filtering)", async function () {
      const { treasury, admin, fulfiller, recipient, other, EVENT_ID } = await registeredEventFixture();

      // Admin submits two candidates; CRE approves only recipient (OPA denied 'other')
      const requestId = await extractRequestId(
        treasury,
        await treasury.connect(admin).requestEligibilityRegistration(
          EVENT_ID, [recipient.address, other.address], [1, 2]
        )
      );

      // CRE writes back only the approved recipient
      await treasury.connect(fulfiller).onReport(
        "0x",
        encodeEligibilityReport(requestId, [recipient.address], [1])
      );

      expect(await treasury.getEligibilityTier(EVENT_ID, recipient.address)).to.equal(1);
      expect(await treasury.getEligibilityTier(EVENT_ID, other.address)).to.equal(0); // not set
    });

    it("reverts requestEligibilityRegistration for unregistered event", async function () {
      const { treasury, admin, recipient } = await deployFixture();
      const unknownEvent = ethers.keccak256(ethers.toUtf8Bytes("UNKNOWN"));
      await expect(
        treasury.connect(admin).requestEligibilityRegistration(
          unknownEvent, [recipient.address], [1]
        )
      ).to.be.revertedWithCustomError(treasury, "EventNotFound");
    });

    it("reverts requestEligibilityRegistration from non-admin", async function () {
      const { treasury, other, recipient, EVENT_ID } = await registeredEventFixture();
      await expect(
        treasury.connect(other).requestEligibilityRegistration(
          EVENT_ID, [recipient.address], [1]
        )
      ).to.be.reverted;
    });
  });

  // ── Full Disbursement Flow ───────────────────────────────────────────────

  describe("Disbursement (Pull Model)", function () {
    /**
     * Full pipeline fixture:
     *  1. Register event + tiers
     *  2. CRE verifies disaster
     *  3. Admin activates event
     *  4. Admin requests eligibility registration (recipient=tier 1, other=tier 2)
     *  5. CRE writes eligibility onchain
     */
    async function activeEventFixture() {
      const ctx = await deployFixture();
      const { treasury, usdc, admin, fulfiller, recipient, other, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = ctx;

      await treasury.connect(admin).deposit(USDC(10_000));
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);

      // Step 1: CRE verifies the disaster event
      const verifyRequestId = await extractRequestId(
        treasury,
        await treasury.connect(admin).requestEventVerification(
          EVENT_ID, JSON.stringify({ usgsId: "us7000abc", region: "US" })
        )
      );
      await treasury.connect(fulfiller).onReport("0x", encodeEventVerificationReport(verifyRequestId, true));
      await treasury.connect(admin).activateEvent(EVENT_ID);

      // Step 2: CRE sets eligibility for both test recipients
      const eligRequestId = await extractRequestId(
        treasury,
        await treasury.connect(admin).requestEligibilityRegistration(
          EVENT_ID,
          [recipient.address, other.address],
          [1, 2]
        )
      );
      await treasury.connect(fulfiller).onReport(
        "0x",
        encodeEligibilityReport(eligRequestId, [recipient.address, other.address], [1, 2])
      );

      return { ...ctx, addr: await treasury.getAddress() };
    }

    it("tier 1 recipient receives standard amount ($50)", async function () {
      const { treasury, usdc, recipient, EVENT_ID } = await activeEventFixture();

      const balanceBefore = await usdc.balanceOf(recipient.address);

      await expect(treasury.connect(recipient).claimDisbursement(EVENT_ID))
        .to.emit(treasury, "Disbursed")
        .withArgs(EVENT_ID, recipient.address, USDC(50));

      expect(await usdc.balanceOf(recipient.address)).to.equal(balanceBefore + USDC(50));
      expect(await treasury.hasClaimed(EVENT_ID, recipient.address)).to.be.true;
    });

    it("tier 2 recipient receives priority amount ($100)", async function () {
      const { treasury, usdc, other, EVENT_ID } = await activeEventFixture();

      const balanceBefore = await usdc.balanceOf(other.address);

      await expect(treasury.connect(other).claimDisbursement(EVENT_ID))
        .to.emit(treasury, "Disbursed")
        .withArgs(EVENT_ID, other.address, USDC(100));

      expect(await usdc.balanceOf(other.address)).to.equal(balanceBefore + USDC(100));
    });

    it("reverts if CRE has not set eligibility (wallet not in batch)", async function () {
      const { treasury, deployer, EVENT_ID } = await activeEventFixture();
      // deployer was not in the eligibility batch
      await expect(treasury.connect(deployer).claimDisbursement(EVENT_ID))
        .to.be.revertedWithCustomError(treasury, "NotEligible");
    });

    it("reverts claim when event is not Active", async function () {
      const { treasury, recipient, EVENT_ID } = await deployFixture();
      await expect(
        treasury.connect(recipient).claimDisbursement(EVENT_ID)
      ).to.be.revertedWithCustomError(treasury, "EventNotActive");
    });

    it("prevents double-claim by same recipient", async function () {
      const { treasury, recipient, EVENT_ID } = await activeEventFixture();

      await treasury.connect(recipient).claimDisbursement(EVENT_ID);
      await expect(
        treasury.connect(recipient).claimDisbursement(EVENT_ID)
      ).to.be.revertedWithCustomError(treasury, "AlreadyClaimed");
    });

    it("enforces per-event cap — reverts when cap exceeded", async function () {
      const [, admin2, fulfiller2, r1, r2] = await ethers.getSigners();

      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = (await MockUSDC.deploy()) as unknown as MockUSDC;

      // perRecipientCap=$60, perEventCap=$100 — two $60 payouts cannot fit
      const ReliefTreasury = await ethers.getContractFactory("ReliefTreasury");
      const treasury = (await ReliefTreasury.deploy(
        await usdc.getAddress(), USDC(60), USDC(1_000), admin2.address
      )) as unknown as ReliefTreasury;

      await treasury.connect(admin2).setFulfillerAuthorization(fulfiller2.address, true);
      await usdc.mint(admin2.address, USDC(1_000));
      await usdc.connect(admin2).approve(await treasury.getAddress(), USDC(1_000));
      await treasury.connect(admin2).deposit(USDC(1_000));

      const eventId = ethers.keccak256(ethers.toUtf8Bytes("CAP-TEST"));
      // tier 2 = $60 (≤ perRecipientCap of $60)
      await treasury.connect(admin2).registerEvent(eventId, USDC(100), [1, 2], [50_000_000n, 60_000_000n]);

      // Verify event
      const iface = treasury.interface;
      const verifyTx = await treasury.connect(admin2).requestEventVerification(eventId, "{}");
      const verifyReceipt = await verifyTx.wait();
      const vLog = verifyReceipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      await treasury.connect(fulfiller2).onReport("0x", encodeEventVerificationReport(vLog!.args.requestId, true));
      await treasury.connect(admin2).activateEvent(eventId);

      // Register eligibility for both recipients (tier 2 = $60)
      const eligTx = await treasury.connect(admin2).requestEligibilityRegistration(
        eventId, [r1.address, r2.address], [2, 2]
      );
      const eligReceipt = await eligTx.wait();
      const eLogs = eligReceipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      await treasury.connect(fulfiller2).onReport(
        "0x",
        encodeEligibilityReport(eLogs!.args.requestId, [r1.address, r2.address], [2, 2])
      );

      // r1 claims $60 — fills most of the $100 event cap ($40 remains)
      await treasury.connect(r1).claimDisbursement(eventId);

      // r2 tries $60 but only $40 remains → PerEventCapExceeded
      await expect(treasury.connect(r2).claimDisbursement(eventId))
        .to.be.revertedWithCustomError(treasury, "PerEventCapExceeded");
    });

    it("unconfigured tier — CRE sets eligible but tier has no amount → TierNotConfigured", async function () {
      const [, admin3, fulfiller3, r3] = await ethers.getSigners();

      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc3 = (await MockUSDC.deploy()) as unknown as MockUSDC;

      const ReliefTreasury = await ethers.getContractFactory("ReliefTreasury");
      const treasury3 = (await ReliefTreasury.deploy(
        await usdc3.getAddress(), USDC(100), USDC(1_000), admin3.address
      )) as unknown as ReliefTreasury;

      await treasury3.connect(admin3).setFulfillerAuthorization(fulfiller3.address, true);
      await usdc3.mint(admin3.address, USDC(1_000));
      await usdc3.connect(admin3).approve(await treasury3.getAddress(), USDC(1_000));
      await treasury3.connect(admin3).deposit(USDC(1_000));

      const eventId = ethers.keccak256(ethers.toUtf8Bytes("TIER-TEST"));
      // Only tier 1 configured — no tier 3
      await treasury3.connect(admin3).registerEvent(eventId, USDC(1_000), [1], [50_000_000n]);

      const iface = treasury3.interface;
      const verifyTx = await treasury3.connect(admin3).requestEventVerification(eventId, "{}");
      const verifyReceipt = await verifyTx.wait();
      const vLog = verifyReceipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      await treasury3.connect(fulfiller3).onReport("0x", encodeEventVerificationReport(vLog!.args.requestId, true));
      await treasury3.connect(admin3).activateEvent(eventId);

      // CRE sets r3 as eligible at tier 3 (which has no configured amount)
      const eligTx = await treasury3.connect(admin3).requestEligibilityRegistration(
        eventId, [r3.address], [3]
      );
      const eligReceipt = await eligTx.wait();
      const eLogs = eligReceipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      await treasury3.connect(fulfiller3).onReport(
        "0x",
        encodeEligibilityReport(eLogs!.args.requestId, [r3.address], [3])
      );

      // Claim should revert TierNotConfigured (tier 3 has no amount)
      await expect(treasury3.connect(r3).claimDisbursement(eventId))
        .to.be.revertedWithCustomError(treasury3, "TierNotConfigured");
    });
  });

  // ── Proof of Delivery ────────────────────────────────────────────────────

  describe("Proof of Delivery", function () {
    it("fulfiller marks delivery confirmed", async function () {
      const { treasury, fulfiller, recipient, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS, admin } =
        await deployFixture();
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);
      await expect(
        treasury.connect(fulfiller).markDelivered(EVENT_ID, recipient.address)
      )
        .to.emit(treasury, "DeliveryConfirmed")
        .withArgs(EVENT_ID, recipient.address);
      expect(await treasury.hasDelivered(EVENT_ID, recipient.address)).to.be.true;
    });

    it("reverts markDelivered from non-fulfiller", async function () {
      const { treasury, other, recipient, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS, admin } =
        await deployFixture();
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);
      await expect(
        treasury.connect(other).markDelivered(EVENT_ID, recipient.address)
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedFulfiller");
    });
  });

  // ── Pause / Emergency Withdraw ───────────────────────────────────────────

  describe("Emergency Controls", function () {
    it("pauses and unpauses", async function () {
      const { treasury, admin } = await deployFixture();
      await treasury.connect(admin).pause();
      expect(await treasury.paused()).to.be.true;
      await treasury.connect(admin).unpause();
      expect(await treasury.paused()).to.be.false;
    });

    it("blocks deposit when paused", async function () {
      const { treasury, admin } = await deployFixture();
      await treasury.connect(admin).pause();
      await expect(treasury.connect(admin).deposit(USDC(100))).to.be.reverted;
    });

    it("emergency withdraw when paused", async function () {
      const { treasury, usdc, admin, other } = await deployFixture();
      const amount = USDC(5_000);
      await treasury.connect(admin).deposit(amount);
      await treasury.connect(admin).pause();

      const balanceBefore = await usdc.balanceOf(other.address);
      await expect(treasury.connect(admin).emergencyWithdraw(other.address, amount))
        .to.emit(treasury, "EmergencyWithdraw")
        .withArgs(other.address, amount);
      expect(await usdc.balanceOf(other.address)).to.equal(balanceBefore + amount);
      // totalDeposited must be decremented so accounting stays accurate
      expect(await treasury.totalDeposited()).to.equal(0n);
    });

    it("reverts emergency withdraw when not paused", async function () {
      const { treasury, admin, other } = await deployFixture();
      await treasury.connect(admin).deposit(USDC(100));
      await expect(
        treasury.connect(admin).emergencyWithdraw(other.address, USDC(100))
      ).to.be.revertedWithCustomError(treasury, "NotPaused");
    });
  });

  // ── Fulfiller Authorization ──────────────────────────────────────────────

  describe("Fulfiller Authorization", function () {
    it("onReport reverts from unauthorized caller", async function () {
      const { treasury, other } = await deployFixture();
      const fakeReport = "0x01" + "0".repeat(128);
      await expect(
        treasury.connect(other).onReport("0x", fakeReport)
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedFulfiller");
    });

  });
});
