import React from 'react'
import ReactDOM from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import App from './App'

// Privy app ID from rwa-gateway /health
const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID ?? 'cmeub0x4t000bk00cgumblsrs'

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
      },
    }}
  >
    <App />
  </PrivyProvider>
)
