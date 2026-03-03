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

function encodeDisbursementReport(requestId: string, allowed: boolean, tier: number): string {
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bool", "uint8"],
    [requestId, allowed, tier]
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
      const tx = await treasury.connect(admin).requestEventVerification(EVENT_ID, ref);
      const receipt = await tx.wait();

      const iface = treasury.interface;
      const requestSentLog = receipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");

      const requestId = requestSentLog!.args.requestId;
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

  // ── Full Disbursement Flow ───────────────────────────────────────────────

  describe("Disbursement (Pull Model)", function () {
    async function activeEventFixture() {
      const ctx = await deployFixture();
      const { treasury, usdc, admin, fulfiller, EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS } = ctx;

      await treasury.connect(admin).deposit(USDC(10_000));

      // Tier amounts committed atomically at registration
      await treasury.connect(admin).registerEvent(EVENT_ID, PER_EVENT_CAP, TIERS, AMOUNTS);

      const ref = JSON.stringify({ usgsId: "us7000abc", region: "US" });
      const tx = await treasury.connect(admin).requestEventVerification(EVENT_ID, ref);
      const receipt = await tx.wait();
      const iface = treasury.interface;
      const requestSentLog = receipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      const requestId = requestSentLog!.args.requestId;

      await treasury.connect(fulfiller).onReport("0x", encodeEventVerificationReport(requestId, true));
      await treasury.connect(admin).activateEvent(EVENT_ID);

      return { ...ctx, addr: await treasury.getAddress() };
    }

    it("tier 1 recipient receives standard amount ($50)", async function () {
      const { treasury, usdc, fulfiller, recipient, EVENT_ID } = await activeEventFixture();

      const balanceBefore = await usdc.balanceOf(recipient.address);
      const tx = await treasury.connect(recipient).claimDisbursement(EVENT_ID);
      const receipt = await tx.wait();
      const iface = treasury.interface;
      const requestSentLog = receipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      const requestId = requestSentLog!.args.requestId;

      await expect(treasury.connect(fulfiller).onReport("0x", encodeDisbursementReport(requestId, true, 1)))
        .to.emit(treasury, "Disbursed")
        .withArgs(EVENT_ID, recipient.address, USDC(50));

      expect(await usdc.balanceOf(recipient.address)).to.equal(balanceBefore + USDC(50));
      expect(await treasury.hasClaimed(EVENT_ID, recipient.address)).to.be.true;
    });

    it("tier 2 recipient receives priority amount ($100)", async function () {
      const { treasury, usdc, fulfiller, other, EVENT_ID } = await activeEventFixture();

      const balanceBefore = await usdc.balanceOf(other.address);
      const tx = await treasury.connect(other).claimDisbursement(EVENT_ID);
      const receipt = await tx.wait();
      const iface = treasury.interface;
      const requestSentLog = receipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      const requestId = requestSentLog!.args.requestId;

      await expect(treasury.connect(fulfiller).onReport("0x", encodeDisbursementReport(requestId, true, 2)))
        .to.emit(treasury, "Disbursed")
        .withArgs(EVENT_ID, other.address, USDC(100));

      expect(await usdc.balanceOf(other.address)).to.equal(balanceBefore + USDC(100));
    });

    it("CRE returns allowed=false → no transfer", async function () {
      const { treasury, usdc, fulfiller, recipient, EVENT_ID } = await activeEventFixture();

      const balanceBefore = await usdc.balanceOf(recipient.address);
      const tx = await treasury.connect(recipient).claimDisbursement(EVENT_ID);
      const receipt = await tx.wait();
      const iface = treasury.interface;
      const requestSentLog = receipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      const requestId = requestSentLog!.args.requestId;

      await treasury.connect(fulfiller).onReport("0x", encodeDisbursementReport(requestId, false, 0));
      expect(await usdc.balanceOf(recipient.address)).to.equal(balanceBefore);
    });

    it("unconfigured tier in CRE callback — no transfer, no revert", async function () {
      const { treasury, usdc, fulfiller, recipient, EVENT_ID } = await activeEventFixture();

      const balanceBefore = await usdc.balanceOf(recipient.address);
      const tx = await treasury.connect(recipient).claimDisbursement(EVENT_ID);
      const receipt = await tx.wait();
      const iface = treasury.interface;
      const requestSentLog = receipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      const requestId = requestSentLog!.args.requestId;

      // Tier 3 has no amount configured — callback must not revert; no transfer
      await expect(
        treasury.connect(fulfiller).onReport("0x", encodeDisbursementReport(requestId, true, 3))
      ).not.to.be.reverted;
      expect(await usdc.balanceOf(recipient.address)).to.equal(balanceBefore);
    });

    it("prevents double-claim by same recipient", async function () {
      const { treasury, fulfiller, recipient, EVENT_ID } = await activeEventFixture();

      const tx = await treasury.connect(recipient).claimDisbursement(EVENT_ID);
      const receipt = await tx.wait();
      const iface = treasury.interface;
      const requestSentLog = receipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      const requestId = requestSentLog!.args.requestId;

      await treasury.connect(fulfiller).onReport("0x", encodeDisbursementReport(requestId, true, 1));
      await expect(
        treasury.connect(recipient).claimDisbursement(EVENT_ID)
      ).to.be.revertedWithCustomError(treasury, "AlreadyClaimed");
    });

    it("any recipient receives payment if CRE approves (no onchain eligibility gate)", async function () {
      const { treasury, usdc, fulfiller, other, EVENT_ID } = await activeEventFixture();

      const balanceBefore = await usdc.balanceOf(other.address);
      const tx = await treasury.connect(other).claimDisbursement(EVENT_ID);
      const receipt = await tx.wait();
      const iface = treasury.interface;
      const requestSentLog = receipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      const requestId = requestSentLog!.args.requestId;

      await expect(treasury.connect(fulfiller).onReport("0x", encodeDisbursementReport(requestId, true, 1)))
        .to.emit(treasury, "Disbursed")
        .withArgs(EVENT_ID, other.address, USDC(50));

      expect(await usdc.balanceOf(other.address)).to.equal(balanceBefore + USDC(50));
    });

    it("reverts claim when event is not Active", async function () {
      const { treasury, recipient, EVENT_ID } = await deployFixture();
      await expect(
        treasury.connect(recipient).claimDisbursement(EVENT_ID)
      ).to.be.revertedWithCustomError(treasury, "EventNotActive");
    });

    it("cap exceeded — CRE callback completes without reverting", async function () {
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

      const ref = "{}";
      const verifyTx = await treasury.connect(admin2).requestEventVerification(eventId, ref);
      const verifyReceipt = await verifyTx.wait();
      const iface = treasury.interface;
      const vLog = verifyReceipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      await treasury.connect(fulfiller2).onReport("0x", encodeEventVerificationReport(vLog!.args.requestId, true));
      await treasury.connect(admin2).activateEvent(eventId);

      // r1 claims tier 2 ($60) — fills the $100 event cap (only $40 remains after)
      const claimTx1 = await treasury.connect(r1).claimDisbursement(eventId);
      const cLog1 = (await claimTx1.wait())!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      await treasury.connect(fulfiller2).onReport("0x", encodeDisbursementReport(cLog1!.args.requestId, true, 2));

      const r2BalanceBefore = await usdc.balanceOf(r2.address);

      // r2 tries tier 2 ($60) but only $40 remains in per-event cap
      // Callback must NOT revert — graceful return, no Disbursed event
      const claimTx2 = await treasury.connect(r2).claimDisbursement(eventId);
      const cLog2 = (await claimTx2.wait())!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      await expect(
        treasury.connect(fulfiller2).onReport("0x", encodeDisbursementReport(cLog2!.args.requestId, true, 2))
      ).not.to.emit(treasury, "Disbursed");

      // r2 receives nothing
      expect(await usdc.balanceOf(r2.address)).to.equal(r2BalanceBefore);
    });

    it("pending guard prevents double-submission before CRE callback", async function () {
      const { treasury, recipient, EVENT_ID } = await activeEventFixture();
      await treasury.connect(recipient).claimDisbursement(EVENT_ID);
      // Second call before callback should revert with PendingRequestExists
      await expect(treasury.connect(recipient).claimDisbursement(EVENT_ID))
        .to.be.revertedWithCustomError(treasury, "PendingRequestExists");
    });

    it("pending guard is cleared after CRE denial — retry is allowed", async function () {
      const { treasury, fulfiller, recipient, EVENT_ID } = await activeEventFixture();
      const tx = await treasury.connect(recipient).claimDisbursement(EVENT_ID);
      const receipt = await tx.wait();
      const iface = treasury.interface;
      const requestSentLog = receipt!.logs
        .map((l: any) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "RequestSent");
      const requestId = requestSentLog!.args.requestId;

      // CRE denies — pending flag must be cleared even on denial
      await treasury.connect(fulfiller).onReport(
        "0x", encodeDisbursementReport(requestId, false, 1)
      );

      // Recipient can retry — should not revert with PendingRequestExists
      await expect(treasury.connect(recipient).claimDisbursement(EVENT_ID))
        .not.to.be.revertedWithCustomError(treasury, "PendingRequestExists");
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

    it("fulfillRequest reverts from unauthorized caller", async function () {
      const { treasury, other } = await deployFixture();
      const requestId = ethers.randomBytes(32);
      await expect(
        treasury.connect(other).fulfillRequest(requestId, "0x")
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedFulfiller");
    });
  });
});
