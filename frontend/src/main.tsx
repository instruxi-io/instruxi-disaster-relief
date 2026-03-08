import React from 'react'
import ReactDOM from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import { sepolia } from 'viem/chains'
import App from './App'

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID ?? ''
if (!PRIVY_APP_ID) throw new Error('VITE_PRIVY_APP_ID is not set in frontend/.env')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <PrivyProvider
    appId={PRIVY_APP_ID}
    config={{
      loginMethods: ['email', 'google', 'wallet'],
      appearance: {
        theme: 'dark',
        accentColor: '#3b82f6',
        logo: 'https://instruxi.io/favicon.ico',
      },
      embeddedWallets: {
        createOnLogin: 'users-without-wallets',
        requireUserPasswordOnCreate: false,
        showWalletUIs: true,
      },
      defaultChain: sepolia,
      supportedChains: [sepolia],
    }}
  >
    <App />
  </PrivyProvider>
)
