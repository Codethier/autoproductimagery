import {createGenerationCreditController, initialGenerationCreditState, type GenerationCreditState} from '../utils/generationCredit'

export function useGenerationCredit() {
  const state = useState<GenerationCreditState>('workspace-generation-credit', initialGenerationCreditState)
  const {t} = useI18n()
  return createGenerationCreditController(useAccount(), useAccountBalance(), state, (key, params) => t(key, params ?? {}))
}
