import React, { useEffect, useState } from 'react'
import { usePrivy, useWallets, useSendTransaction } from '@privy-io/react-auth'
import { JsonRpcProvider, Contract, Interface, keccak256, toUtf8Bytes } from 'ethers'
import styles from './App.module.css'

// ── Config ─────────────────────────────────────────────────────────────────

const ENFORCER_URL = import.meta.env.VITE_ENFORCER_URL
  ?? 'https://enforcer-v2-dev.instruxi.dev/api/v1/enforcer'
const TREASURY_ADDRESS = import.meta.env.VITE_TREASURY_ADDRESS ?? ''
const DEFAULT_EVENT_ID = import.meta.env.VITE_DEFAULT_EVENT_ID ?? ''
const SEPOLIA_RPC = import.meta.env.VITE_SEPOLIA_RPC ?? 'https://rpc.sepolia.org'

// Minimal ABI — only what the frontend needs
const TREASURY_ABI = [
  'function claimDisbursement(bytes32 eventId) external',
  'function getEligibilityTier(bytes32 eventId, address recipient) external view returns (uint8)',
  'function hasClaimed(bytes32 eventId, address recipient) external view returns (bool)',
]

// ── Types ───────────────────────────────────────────────────────────────────

type Step = 'idle' | 'registering' | 'checking' | 'claiming' | 'done' | 'error'

interface Status {
  eligible: number   // tier (0 = not eligible)
  disbursed: boolean
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getEnforcerJwt(privyToken: string): Promise<string> {
  const res = await fetch(`${ENFORCER_URL}/auth/privy`, {
    headers: { Authorization: `Bearer ${privyToken}` },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.message ?? 'Enforcer auth failed')
  return data?.data?.token ?? data?.token ?? ''
}

async function registerWithEnforcer(privyToken: string, walletAddress: string): Promise<void> {
  const jwt = await getEnforcerJwt(privyToken)
  // Register the wallet address so it can be added to groups / OPA policy
  const res = await fetch(`${ENFORCER_URL}/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ account_address: walletAddress }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    // 409 = already registered — that's fine
    if (res.status !== 409) throw new Error(data?.message ?? 'Registration failed')
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy()
  const { wallets } = useWallets()
  const { sendTransaction } = useSendTransaction()

  const [eventId, setEventId] = useState(DEFAULT_EVENT_ID)
  const [step, setStep] = useState<Step>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [error, setError] = useState('')
  const [recipientStatus, setRecipientStatus] = useState<Status | null>(null)
  const [txHash, setTxHash] = useState('')

  // Embedded wallet (Privy-managed) or connected wallet
  const wallet = wallets[0]
  const walletAddress = wallet?.address ?? ''

  // Auto-register wallet with enforcer once we have a wallet + are authenticated
  useEffect(() => {
    if (!authenticated || !walletAddress) return
    getAccessToken()
      .then(token => token ? registerWithEnforcer(token, walletAddress) : undefined)
      .catch(console.warn) // silent — they might already be registered
  }, [authenticated, walletAddress])

  async function checkEligibility() {
    if (!walletAddress || !eventId) return
    setStep('checking')
    setError('')
    try {
      const provider = new JsonRpcProvider(SEPOLIA_RPC)
      const contract = new Contract(TREASURY_ADDRESS, TREASURY_ABI, provider)
      // keccak256 matches how hardhat tasks hash the event ID on registration
      const eventIdBytes = eventId.startsWith('0x') ? eventId : keccak256(toUtf8Bytes(eventId))
      const tier: bigint = await contract.getEligibilityTier(eventIdBytes, walletAddress)
      const claimed: boolean = await contract.hasClaimed(eventIdBytes, walletAddress)
      setRecipientStatus({ eligible: Number(tier), disbursed: claimed })
      setStep('idle')
    } catch (e: any) {
      setError(e.message)
      setStep('error')
    }
  }

  async function claim() {
    if (!walletAddress || !eventId) return
    setStep('claiming')
    setError('')
    setTxHash('')
    try {
      // keccak256 matches how hardhat tasks hash the event ID on registration
      const eventIdBytes = eventId.startsWith('0x') ? eventId : keccak256(toUtf8Bytes(eventId))
      const iface = new Interface(TREASURY_ABI)
      const data = iface.encodeFunctionData('claimDisbursement', [eventIdBytes]) as `0x${string}`
      setStatusMsg('Approve the transaction in your wallet...')
      const receipt = await sendTransaction({ to: TREASURY_ADDRESS as `0x${string}`, data, chainId: 11155111 })
      setTxHash(receipt.transactionHash)
      setRecipientStatus(s => s ? { ...s, disbursed: true } : s)
      setStep('done')
    } catch (e: any) {
      setError(e.message)
      setStep('error')
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!ready) {
    return (
      <div className={styles.centered}>
        <div className={styles.spinner} />
      </div>
    )
  }

  if (!authenticated) {
    return (
      <div className={styles.centered}>
        <div className={styles.card}>
          <div className={styles.logo}>🌊</div>
          <h1 className={styles.title}>Disaster Relief Distribution</h1>
          <p className={styles.subtitle}>
            Sign in to check your eligibility and claim your disbursement.
            A wallet will be created for you automatically.
          </p>
          <button className={styles.btn} onClick={login}>
            Sign In to Claim
          </button>
          <p className={styles.note}>
            Powered by Instruxi · Chainlink CRE · Privy
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.logo}>🌊 Disaster Relief</span>
        <div className={styles.userInfo}>
          <span className={styles.email}>{user?.email?.address}</span>
          <button className={styles.btnSmall} onClick={logout}>Sign Out</button>
        </div>
      </header>

      <main className={styles.main}>
        {/* Wallet */}
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>Your Wallet</h2>
          {walletAddress ? (
            <div className={styles.walletBox}>
              <span className={styles.walletLabel}>Address</span>
              <code className={styles.walletAddr}>{walletAddress}</code>
            </div>
          ) : (
            <p className={styles.muted}>Creating your wallet...</p>
          )}
        </section>

        {/* Claim */}
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>Claim Disbursement</h2>

          <label className={styles.label}>Event ID</label>
          <input
            className={styles.input}
            value={eventId}
            onChange={e => { setEventId(e.target.value); setRecipientStatus(null) }}
            placeholder="MMR-EQ-2025-M77 or 0x<bytes32>"
          />

          <div className={styles.btnRow}>
            <button
              className={styles.btnOutline}
              onClick={checkEligibility}
              disabled={!walletAddress || !eventId || step === 'checking'}
            >
              {step === 'checking' ? 'Checking...' : 'Check Eligibility'}
            </button>

            {recipientStatus && recipientStatus.eligible > 0 && !recipientStatus.disbursed && (
              <button
                className={styles.btn}
                onClick={claim}
                disabled={step === 'claiming'}
              >
                {step === 'claiming' ? 'Claiming...' : `Claim (Tier ${recipientStatus.eligible})`}
              </button>
            )}
          </div>

          {/* Status */}
          {recipientStatus && (
            <div className={`${styles.statusBox} ${recipientStatus.eligible === 0 ? styles.statusWarn : recipientStatus.disbursed ? styles.statusSuccess : styles.statusInfo}`}>
              {recipientStatus.eligible === 0 && (
                <>
                  <strong>Not eligible</strong>
                  <p>Your wallet has not been registered for this event yet. Contact your relief coordinator.</p>
                </>
              )}
              {recipientStatus.eligible > 0 && recipientStatus.disbursed && (
                <>
                  <strong>Already claimed ✓</strong>
                  <p>Disbursement for this event has already been sent to your wallet.</p>
                </>
              )}
              {recipientStatus.eligible > 0 && !recipientStatus.disbursed && (
                <>
                  <strong>Eligible — Tier {recipientStatus.eligible}</strong>
                  <p>You are approved to receive funds for this event.</p>
                </>
              )}
            </div>
          )}

          {step === 'done' && txHash && (
            <div className={styles.statusBox + ' ' + styles.statusSuccess}>
              <strong>Claimed successfully ✓</strong>
              <p>
                Tx:{' '}
                <a
                  href={`https://sepolia.etherscan.io/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.link}
                >
                  {txHash.slice(0, 20)}...
                </a>
              </p>
            </div>
          )}

          {statusMsg && step === 'claiming' && (
            <p className={styles.muted}>{statusMsg}</p>
          )}

          {error && (
            <div className={styles.statusBox + ' ' + styles.statusError}>
              <strong>Error</strong>
              <p>{error}</p>
            </div>
          )}
        </section>

        {/* How it works */}
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>How It Works</h2>
          <ol className={styles.steps}>
            <li>A charity funds the USDC treasury smart contract</li>
            <li>Chainlink CRE verifies the disaster event via 2-of-3 API consensus</li>
            <li>The relief coordinator uploads a recipient roster</li>
            <li>Chainlink CRE validates each recipient via OPA policy and writes eligibility onchain</li>
            <li>Eligible recipients claim directly — funds arrive in seconds</li>
            <li>Every action produces a TrustSync attestation for audit</li>
          </ol>
        </section>
      </main>
    </div>
  )
}
