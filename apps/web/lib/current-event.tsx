'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiUrl } from './auth-client';

/**
 * Which trip the console is working on.
 *
 * A group is the umbrella; an event is the trip; the roster, the rounds, the tee sheet, the
 * cup and the standings all belong to one. Every page used to choose an event for itself,
 * usually "the first one the API returned" — so switching event on one page changed nothing
 * anywhere else, and the rounds page did not choose at all: it merged every event's rounds
 * into a single list, which is why rounds looked unattached to anything.
 *
 * One choice, held here, remembered between visits.
 */
export interface EventSummary {
  id: string;
  name: string;
  year: number;
  status: string;
}

interface CurrentEvent {
  events: EventSummary[];
  eventId: string;
  event: EventSummary | null;
  setEventId: (id: string) => void;
  loading: boolean;
  signedOut: boolean;
  reload: () => Promise<void>;
}

const Context = createContext<CurrentEvent | null>(null);
const REMEMBERED = 'ddga.event-id';

export function CurrentEventProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventId, setChosen] = useState('');
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);

  const reload = useCallback(async () => {
    const response = await fetch(`${apiUrl}/api/events`, { credentials: 'include' });
    if (response.status === 401) {
      setSignedOut(true);
      setLoading(false);
      return;
    }
    const loaded = ((await response.json()) as { events?: EventSummary[] }).events ?? [];
    setEvents(loaded);
    setSignedOut(false);
    setLoading(false);

    setChosen((current) => {
      if (current !== '' && loaded.some((event) => event.id === current)) return current;
      let remembered: string | null = null;
      try {
        remembered = window.localStorage.getItem(REMEMBERED);
      } catch {
        // A browser refusing storage is not a reason to fail; fall back to the newest.
      }
      if (remembered !== null && loaded.some((event) => event.id === remembered)) {
        return remembered;
      }
      return loaded[0]?.id ?? '';
    });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setEventId = useCallback((id: string) => {
    setChosen(id);
    try {
      window.localStorage.setItem(REMEMBERED, id);
    } catch {
      // Remembering is a convenience. Not remembering is survivable.
    }
  }, []);

  const value = useMemo<CurrentEvent>(
    () => ({
      events,
      eventId,
      event: events.find((entry) => entry.id === eventId) ?? null,
      setEventId,
      loading,
      signedOut,
      reload,
    }),
    [events, eventId, setEventId, loading, signedOut, reload],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCurrentEvent(): CurrentEvent {
  const value = useContext(Context);
  if (value === null) {
    throw new Error('useCurrentEvent must be used inside CurrentEventProvider');
  }
  return value;
}
