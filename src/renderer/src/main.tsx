import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/luckiest-guy/400.css'
import '@fontsource/nunito/400.css'
import '@fontsource/nunito/700.css'
import '@fontsource/nunito/900.css'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
