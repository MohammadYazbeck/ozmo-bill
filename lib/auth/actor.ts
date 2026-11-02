import { AsyncLocalStorage } from 'node:async_hooks'
import type { Principal } from './types'

const actor = new AsyncLocalStorage<Principal>()
export const withActor = <T>(user: Principal, work: () => T): T => actor.run(user, work)
export const currentActor = () => actor.getStore()?.username
export const currentActorName = () => actor.getStore()?.name
