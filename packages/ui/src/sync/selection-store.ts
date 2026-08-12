/**
 * Selection Store — per-session model, agent, and variant selections.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { createDeferredSafeJSONStorage } from "@/stores/utils/safeStorage"

type ModelSelection = { providerId: string; modelId: string }
type LastUsedProvider = { providerID: string; modelID: string; variant?: string }
type AgentModelSelectionEntries = [string, [string, ModelSelection][]][]
type AgentModelVariantEntries = [string, [string, [string, string][]][]][]
type PersistedSelectionState = {
  sessionModelSelections?: [string, ModelSelection][]
  sessionAgentSelections?: [string, string][]
  sessionAgentModelSelections?: AgentModelSelectionEntries
  sessionAgentModelVariants?: AgentModelVariantEntries
  lastUsedProvider?: LastUsedProvider | null
}

export type SelectionState = {
  sessionModelSelections: Map<string, ModelSelection>
  sessionAgentSelections: Map<string, string>
  sessionAgentModelSelections: Map<string, Map<string, ModelSelection>>
  sessionAgentModelVariants: Map<string, Map<string, Map<string, string>>>
  lastUsedProvider: LastUsedProvider | null

  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void
  getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void
  getSessionAgentSelection: (sessionId: string) => string | null
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void
  getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | undefined
  /**
   * Variant stored for a (session, model) pair regardless of which agent
   * committed it. A thinking variant belongs to the model, not to the agent
   * (issue #2531): switching build ↔ plan must not reset the thinking mode.
   */
  getModelVariantForSession: (sessionId: string, providerId: string, modelId: string) => string | undefined
}

const isPersistedSelectionState = (state: unknown): state is PersistedSelectionState => (
  typeof state === "object" && state !== null
)

// Maximum number of sessions to persist to local storage to prevent unbounded growth
const MAX_PERSISTED_SESSIONS = 150

export const useSelectionStore = create<SelectionState>()(
  persist(
    (set, get) => ({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      sessionAgentModelVariants: new Map(),
      lastUsedProvider: null,

      saveSessionModelSelection: (sessionId, providerId, modelId) =>
        set((s) => {
          const map = new Map(s.sessionModelSelections)
          map.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          map.set(sessionId, { providerId, modelId })
          // Keep the last-used variant only when the same model is re-selected;
          // switching models clears it until a variant is committed again.
          const sameModel = s.lastUsedProvider?.providerID === providerId && s.lastUsedProvider?.modelID === modelId
          return {
            sessionModelSelections: map,
            lastUsedProvider: {
              providerID: providerId,
              modelID: modelId,
              variant: sameModel ? s.lastUsedProvider?.variant : undefined,
            },
          }
        }),

      getSessionModelSelection: (sessionId) => get().sessionModelSelections.get(sessionId) ?? null,

      saveSessionAgentSelection: (sessionId, agentName) =>
        set((s) => {
          if (s.sessionAgentSelections.get(sessionId) === agentName) return s
          const map = new Map(s.sessionAgentSelections)
          map.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          map.set(sessionId, agentName)
          return { sessionAgentSelections: map }
        }),

      getSessionAgentSelection: (sessionId) => get().sessionAgentSelections.get(sessionId) ?? null,

      saveAgentModelForSession: (sessionId, agentName, providerId, modelId) =>
        set((s) => {
          const existing = s.sessionAgentModelSelections.get(sessionId)?.get(agentName)
          if (existing?.providerId === providerId && existing?.modelId === modelId) return s
          const outer = new Map(s.sessionAgentModelSelections)
          const inner = new Map(outer.get(sessionId) ?? new Map())

          outer.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          inner.set(agentName, { providerId, modelId })
          outer.set(sessionId, inner)

          return { sessionAgentModelSelections: outer }
        }),

      getAgentModelForSession: (sessionId, agentName) =>
        get().sessionAgentModelSelections.get(sessionId)?.get(agentName) ?? null,

      saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) => {
        const key = `${providerId}/${modelId}`
        set((s) => {
          const agentMap = s.sessionAgentModelVariants.get(sessionId)
          const existing = agentMap?.get(agentName)?.get(key)

          const nextLastUsedProvider = { providerID: providerId, modelID: modelId, variant }

          if (!variant) {
            if (!agentMap || !agentMap.get(agentName)?.has(key)) {
              return { lastUsedProvider: nextLastUsedProvider }
            }
            const nextVariants = new Map(s.sessionAgentModelVariants)
            const nextAgentMap = new Map(agentMap)
            const nextModelMap = new Map(nextAgentMap.get(agentName)!)
            nextModelMap.delete(key)
            if (nextModelMap.size === 0) {
              nextAgentMap.delete(agentName)
            } else {
              nextAgentMap.set(agentName, nextModelMap)
            }
            if (nextAgentMap.size === 0) {
              nextVariants.delete(sessionId)
            } else {
              nextVariants.set(sessionId, nextAgentMap)
            }
            return { sessionAgentModelVariants: nextVariants, lastUsedProvider: nextLastUsedProvider }
          }

          if (existing === variant) {
            return { lastUsedProvider: nextLastUsedProvider }
          }
          const nextVariants = new Map(s.sessionAgentModelVariants)
          const nextAgentMap = new Map(agentMap ?? new Map())
          const nextModelMap = new Map(nextAgentMap.get(agentName) ?? new Map())
          nextModelMap.set(key, variant)
          nextAgentMap.set(agentName, nextModelMap)
          nextVariants.set(sessionId, nextAgentMap)
          return { sessionAgentModelVariants: nextVariants, lastUsedProvider: nextLastUsedProvider }
        })
      },

      getAgentModelVariantForSession: (sessionId, agentName, providerId, modelId) => {
        const key = `${providerId}/${modelId}`
        return get().sessionAgentModelVariants.get(sessionId)?.get(agentName)?.get(key)
      },

      getModelVariantForSession: (sessionId, providerId, modelId) => {
        const agentMap = get().sessionAgentModelVariants.get(sessionId)
        if (!agentMap) return undefined
        const key = `${providerId}/${modelId}`
        for (const modelMap of agentMap.values()) {
          const variant = modelMap.get(key)
          if (variant) return variant
        }
        return undefined
      },
    }),
    {
      name: "selection-store",
      version: 1,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => {
        // Convert Maps to arrays and slice to keep only the most recent MAX_PERSISTED_SESSIONS
        const models = Array.from(state.sessionModelSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agents = Array.from(state.sessionAgentSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agentModels = Array.from(state.sessionAgentModelSelections.entries())
          .slice(-MAX_PERSISTED_SESSIONS)
          .map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())])
        const agentVariants = Array.from(state.sessionAgentModelVariants.entries())
          .slice(-MAX_PERSISTED_SESSIONS)
          .map(([sessionId, agentMap]) => [
            sessionId,
            Array.from(agentMap.entries()).map(([agentName, modelMap]) => [agentName, Array.from(modelMap.entries())]),
          ])

        return {
          sessionModelSelections: models,
          sessionAgentSelections: agents,
          sessionAgentModelSelections: agentModels,
          sessionAgentModelVariants: agentVariants,
          lastUsedProvider: state.lastUsedProvider,
        }
      },
      merge: (persistedState: unknown, currentState) => {
        const persisted = isPersistedSelectionState(persistedState) ? persistedState : undefined
        const agentModelSelections = new Map<string, Map<string, ModelSelection>>()
        if (Array.isArray(persisted?.sessionAgentModelSelections)) {
          persisted.sessionAgentModelSelections.forEach(([sessionId, agentArray]) => {
            agentModelSelections.set(sessionId, new Map(agentArray))
          })
        }
        const agentModelVariants = new Map<string, Map<string, Map<string, string>>>()
        if (Array.isArray(persisted?.sessionAgentModelVariants)) {
          persisted.sessionAgentModelVariants.forEach(([sessionId, agentArray]) => {
            agentModelVariants.set(
              sessionId,
              new Map(agentArray.map(([agentName, entries]) => [agentName, new Map(entries)])),
            )
          })
        }

        return {
          ...currentState,
          lastUsedProvider: persisted?.lastUsedProvider ?? currentState.lastUsedProvider,
          sessionModelSelections: new Map(persisted?.sessionModelSelections ?? []),
          sessionAgentSelections: new Map(persisted?.sessionAgentSelections ?? []),
          sessionAgentModelSelections: agentModelSelections,
          sessionAgentModelVariants: agentModelVariants,
        }
      },
      migrate: (persistedState: unknown) => {
        // Scaffold for future schema migrations
        return persistedState
      }
    }
  )
)
