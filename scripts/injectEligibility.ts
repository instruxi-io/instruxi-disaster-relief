/**
 * injectEligibility.ts
 * Admin-only helper: bypasses CRE and directly writes eligibility onchain.
 * Use for demo/testing when Privy embedded wallet signing is unavailable.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/injectEligibility.ts \
 *     --event-id 0x... --recipient 0x... --tier 1
 */

import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
dotenv.config()

const RELIEF_TREASURY_ADDRESS = process.env.RELIEF_TREASURY_ADDRESS ?? ''
const RPC_URL = `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY?.startsWith('0x')
  ? process.env.DEPLOYER_PRIVATE_KEY
  : `0x${process.env.DEPLOYER_PRIVATE_KEY}`

const ABI = [
  'function requestEligibilityRegistration(bytes32 eventId, address[] calldata recipients, uint8[] calldata tiers) external returns (bytes32 requestId)',
  'function setFulfillerAuthorization(address fulfiller, bool authorized) external',
  'function onReport(bytes calldata metadata, bytes calldata report) external',
  'function getEligibilityTier(bytes32 eventId, address recipient) external view returns (uint8)',
  'event EligibilityRegistrationRequested(bytes32 indexed requestId, bytes32 indexed eventId)',
]

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  return {
    eventId: get('--event-id') ?? '',
    recipient: get('--recipient') ?? '',
    tier: parseInt(get('--tier') ?? '1'),
  }
}

async function main() {
  const { eventId, recipient, tier } = parseArgs()
  if (!eventId || !recipient) {
    console.error('Usage: --event-id 0x... --recipient 0x... --tier 1')
    process.exit(1)
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY, provider)
  const contract = new ethers.Contract(RELIEF_TREASURY_ADDRESS, ABI, signer)

  console.log(`Admin:     ${signer.address}`)
  console.log(`Contract:  ${RELIEF_TREASURY_ADDRESS}`)
  console.log(`Event ID:  ${eventId}`)
  console.log(`Recipient: ${recipient}  tier=${tier}`)
  console.log()

  // Step 1: request eligibility registration to get a requestId
  console.log('Step 1: requestEligibilityRegistration...')
  const tx1 = await contract.requestEligibilityRegistration(eventId, [recipient], [tier])
  const receipt1 = await tx1.wait()
  const iface = new ethers.Interface(ABI)
  let requestId = ''
  for (const log of receipt1.logs) {
    try {
      const parsed = iface.parseLog(log)
      if (parsed?.name === 'EligibilityRegistrationRequested') {
        requestId = parsed.args[0]
        break
      }
    } catch {}
  }
  if (!requestId) throw new Error('Could not find requestId in logs')
  console.log(`  requestId: ${requestId}`)

  // Step 2: authorize admin as fulfiller
  console.log('Step 2: setFulfillerAuthorization(admin, true)...')
  const tx2 = await contract.setFulfillerAuthorization(signer.address, true)
  await tx2.wait()
  console.log('  done')

  // Step 3: encode and submit the onReport payload directly
  console.log('Step 3: onReport with eligibility payload...')
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address[]', 'uint8[]'],
    [requestId, [recipient], [tier]]
  )
  // prefix 0x02 = REPORT_ELIGIBILITY
  const report = ethers.concat(['0x02', payload])
  const metadata = ethers.toUtf8Bytes('admin-inject')
  const tx3 = await contract.onReport(metadata, report)
  await tx3.wait()
  console.log('  done')

  // Step 4: revoke admin fulfiller authorization
  console.log('Step 4: revoking fulfiller authorization...')
  const tx4 = await contract.setFulfillerAuthorization(signer.address, false)
  await tx4.wait()
  console.log('  done')

  // Verify
  const resultTier = await contract.getEligibilityTier(eventId, recipient)
  console.log()
  console.log(`Result: getEligibilityTier => ${resultTier}`)
  if (Number(resultTier) > 0) {
    console.log(`SUCCESS — ${recipient} is eligible at tier ${resultTier}`)
  } else {
    console.log('FAILED — tier is still 0')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
