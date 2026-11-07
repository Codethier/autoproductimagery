import {createGenerationCreditController, initialGenerationCreditState, type GenerationCreditState} from '../utils/generationCredit'

export function useGenerationCredit() {
  const state = useState<GenerationCreditState>('workspace-generation-credit', initialGenerationCreditState)
  return createGenerationCreditController(useAccount(), useAccountBalance(), state)
}
