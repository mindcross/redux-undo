import * as debug from './debug'
import { ActionTypes } from './actions'
import { parseActions, isHistory } from './helpers'

// lengthWithoutFuture: get length of history
function lengthWithoutFuture (history) {
  return history.past.length + 1
}

// insert: insert `state` into history, which means adding the current state
//         into `past`, setting the new `state` as `present` and erasing
//         the `future`.
function insert (history, state, limit) {
  debug.log('inserting', state)
  debug.log('new free: ', limit - lengthWithoutFuture(history))

  const { past, present } = history
  const historyOverflow = limit && lengthWithoutFuture(history) >= limit

  const pastSliced = past.slice(historyOverflow ? 1 : 0)
  const newPast = present != null
    ? [
      ...pastSliced,
      present
    ] : pastSliced

  return {
    past: newPast,
    present: state,
    future: []
  }
}

// undo: go back to the previous point in history
function undo (history) {
  const { past, present, future } = history

  if (past.length <= 0) return history

  const newPresent = past[past.length - 1]
  const newFuture = [
    present,
    ...future
  ]
  return {
    past: past.slice(0, past.length - 1), // remove last element from past
    present: newPresent, // set element as new present
    future: newFuture
  }
}

// redo: go to the next point in history
function redo (history) {
  const { past, present, future } = history

  if (future.length <= 0) return history

  const newPast = [
    ...past,
    present
  ]

  const newPresent = future[0]
  const newFuture = future.slice(1, future.length)
  return {
    future: newFuture, // remove element from future
    present: newPresent, // set element as new present
    past: newPast
  }
}

// jumpToFuture: jump to requested index in future history
function jumpToFuture (history, index) {
  if (index === 0) return redo(history)
  if (index < 0 || index >= history.future.length) return history

  const { past, present, future } = history

  const newPresent = future[index]

  return {
    future: future.slice(index + 1),
    present: newPresent,
    past: past.concat([present])
      .concat(future.slice(0, index))
  }
}

// jumpToPast: jump to requested index in past history
function jumpToPast (history, index) {
  if (index === history.past.length - 1) return undo(history)
  if (index < 0 || index >= history.past.length) return history

  const { past, present, future } = history

  const newPresent = past[index]

  return {
    future: past.slice(index + 1)
      .concat([present])
      .concat(future),
    present: newPresent,
    past: past.slice(0, index)
  }
}

// jump: jump n steps in the past or forward
function jump (history, n) {
  if (n > 0) return jumpToFuture(history, n - 1)
  if (n < 0) return jumpToPast(history, history.past.length + n)
  return history
}

// createHistory
function createHistory (state) {
  // ignoreInitialState essentially prevents the user from undoing to the
  // beginning, in the case that the undoable reducer handles initialization
  // in a way that can't be redone simply
  return {
    past: [],
    present: state,
    future: []
  }
}

// helper to dynamically match in the reducer's switch-case
function actionTypeAmongClearHistoryType (actionType, clearHistoryType) {
  return clearHistoryType.indexOf(actionType) > -1 ? actionType : !actionType
}

// redux-undo higher order reducer
export default function undoable (reducer, rawConfig = {}) {
  debug.set(rawConfig.debug)

  const config = {
    initTypes: parseActions(rawConfig.initTypes, ['@@redux-undo/INIT']),
    limit: rawConfig.limit,
    filter: rawConfig.filter || (() => true),
    undoType: rawConfig.undoType || ActionTypes.UNDO,
    redoType: rawConfig.redoType || ActionTypes.REDO,
    jumpToPastType: rawConfig.jumpToPastType || ActionTypes.JUMP_TO_PAST,
    jumpToFutureType: rawConfig.jumpToFutureType || ActionTypes.JUMP_TO_FUTURE,
    jumpType: rawConfig.jumpType || ActionTypes.JUMP,
    clearHistoryType:
      Array.isArray(rawConfig.clearHistoryType)
      ? rawConfig.clearHistoryType
      : [rawConfig.clearHistoryType || ActionTypes.CLEAR_HISTORY],
    neverSkipReducer: rawConfig.neverSkipReducer || false
  }

  return (state = config.history, action = {}, ...slices) => {
    debug.start(action, state)

    let history = state
    if (!config.history) {
      debug.log('history is uninitialized')

      if (state === undefined) {
        history = config.history = createHistory(reducer(
          state, { type: '@@redux-undo/CREATE_HISTORY' }),
          ...slices
        )
        debug.log('do not initialize on probe actions')
      } else if (isHistory(state)) {
        history = state
        debug.log('initialHistory initialized: initialState is a history', config.history)
      } else {
        history = config.history = createHistory(state)
        debug.log('initialHistory initialized: initialState is not a history', config.history)
      }
    }

    const skipReducer = (res) => config.neverSkipReducer
      ? {
        ...res,
        present: reducer(res.present, action, ...slices)
      } : res

    let res
    switch (action.type) {
      case undefined:
        return history

      case config.undoType:
        res = undo(history)
        debug.log('perform undo')
        debug.end(res)
        return skipReducer(res)

      case config.redoType:
        res = redo(history)
        debug.log('perform redo')
        debug.end(res)
        return skipReducer(res)

      case config.jumpToPastType:
        res = jumpToPast(history, action.index)
        debug.log(`perform jumpToPast to ${action.index}`)
        debug.end(res)
        return skipReducer(res)

      case config.jumpToFutureType:
        res = jumpToFuture(history, action.index)
        debug.log(`perform jumpToFuture to ${action.index}`)
        debug.end(res)
        return skipReducer(res)

      case config.jumpType:
        res = jump(history, action.index)
        debug.log(`perform jump to ${action.index}`)
        debug.end(res)
        return skipReducer(res)

      case actionTypeAmongClearHistoryType(action.type, config.clearHistoryType):
        res = createHistory(history.present)
        debug.log('perform clearHistory')
        debug.end(res)
        return skipReducer(res)

      default:
        res = reducer(
          history.present,
          action,
          ...slices
        )

        if (config.initTypes.some((actionType) => actionType === action.type)) {
          debug.log('reset history due to init action')
          debug.end(config.history)
          return config.history
        }

        if (history.present === res) {
          // Don't handle this action. Do not call debug.end here,
          // because this action should not produce side effects to the console
          return history
        }

        if (typeof config.filter === 'function' && !config.filter(action, res, history)) {
          // if filtering an action, merely update the present
          const nextState = {
            ...history,
            present: res
          }
          debug.log('filter prevented action, not storing it')
          debug.end(nextState)
          return nextState
        } else {
          // If the action wasn't filtered, insert normally
          history = insert(history, res, config.limit)

          debug.log('inserted new state into history')
          debug.end(history)
          return history
        }
    }
  }
}
