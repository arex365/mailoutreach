"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { contactsHref, mutateParams, withCompany } from "./url";

/**
 * Shared state for the Contacts screen:
 *  - URL navigation that builds on changes still loading (quick filter clicks don't undo each other);
 *  - the company panel (opens instantly, optimistic, while the server renders it);
 *  - the "Add company" dialog, which several buttons can open.
 */

type ContactsContextValue = {
  /** The company whose panel is open (optimistic while the page loads). */
  openCompanyId: number | null;
  /** The company the server has already rendered the panel for. */
  renderedCompanyId: number | null;
  openCompany: (id: number) => void;
  closeCompany: () => void;
  /** Changes the URL query (filters, sort, page…) and re-renders the page on the server. */
  navigate: (change: (p: URLSearchParams) => void, opts?: { replace?: boolean }) => void;
  /** Query string of the view being shown or loading (without "?"). */
  currentSearch: () => string;
  isNavigating: boolean;
  addOpen: boolean;
  setAddOpen: (open: boolean) => void;
};

const ContactsContext = createContext<ContactsContextValue | null>(null);

export function useContacts(): ContactsContextValue {
  const ctx = useContext(ContactsContext);
  if (!ctx) throw new Error("useContacts must be used inside <ContactsProvider>.");
  return ctx;
}

export function ContactsProvider({ companyId, children }: { companyId: number | null; children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const pendingRef = useRef<string | null>(null);
  const [isNavigating, startNavigation] = useTransition();
  const [, startPanelTransition] = useTransition();
  const [openCompanyId, setOptimisticCompanyId] = useOptimistic<number | null>(companyId);
  const [addOpen, setAddOpen] = useState(false);

  // Once every navigation has landed, the URL is the source of truth again.
  useEffect(() => {
    if (!isNavigating) pendingRef.current = null;
  }, [isNavigating, search]);

  const currentSearch = useCallback(() => pendingRef.current ?? search, [search]);

  const navigate = useCallback(
    (change: (p: URLSearchParams) => void, opts?: { replace?: boolean }) => {
      const next = mutateParams(pendingRef.current ?? search, change);
      pendingRef.current = next;
      const href = contactsHref(next);
      startNavigation(() => {
        if (opts?.replace) router.replace(href, { scroll: false });
        else router.push(href, { scroll: false });
      });
    },
    [router, search],
  );

  const openCompany = useCallback(
    (id: number) => {
      startPanelTransition(() => {
        setOptimisticCompanyId(id);
        router.push(contactsHref(withCompany(pendingRef.current ?? search, id)), { scroll: false });
      });
    },
    [router, search, setOptimisticCompanyId],
  );

  const closeCompany = useCallback(() => {
    startPanelTransition(() => {
      setOptimisticCompanyId(null);
      router.replace(contactsHref(withCompany(pendingRef.current ?? search, null)), { scroll: false });
    });
  }, [router, search, setOptimisticCompanyId]);

  const value = useMemo<ContactsContextValue>(
    () => ({
      openCompanyId,
      renderedCompanyId: companyId,
      openCompany,
      closeCompany,
      navigate,
      currentSearch,
      isNavigating,
      addOpen,
      setAddOpen,
    }),
    [openCompanyId, companyId, openCompany, closeCompany, navigate, currentSearch, isNavigating, addOpen],
  );

  return <ContactsContext.Provider value={value}>{children}</ContactsContext.Provider>;
}
