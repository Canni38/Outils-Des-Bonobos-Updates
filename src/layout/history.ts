export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

const MAX_HISTORY_ENTRIES = 100;

export function createHistory<T>(initialValue: T): HistoryState<T> {
  return {
    past: [],
    present: initialValue,
    future: [],
  };
}

export function commitHistory<T>(
  state: HistoryState<T>,
  nextValue: T,
): HistoryState<T> {
  if (Object.is(state.present, nextValue)) {
    return state;
  }

  return {
    past: [...state.past, state.present].slice(-MAX_HISTORY_ENTRIES),
    present: nextValue,
    future: [],
  };
}

export function undoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.past.length === 0) {
    return state;
  }

  const previous = state.past[state.past.length - 1];
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future],
  };
}

export function redoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.future.length === 0) {
    return state;
  }

  const next = state.future[0];
  return {
    past: [...state.past, state.present].slice(-MAX_HISTORY_ENTRIES),
    present: next,
    future: state.future.slice(1),
  };
}
