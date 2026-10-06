"use client";

import { useTransition, type FormEvent } from "react";

/**
 * Submit handler for forms driven by useActionState.
 * With <form action={…}> React 19 resets every field after the action finishes — so after
 * an error the person would have to type everything again. Submitting through onSubmit
 * inside a transition keeps what they typed. Usage:
 *   const [state, dispatch, pending] = useActionState(myAction, null);
 *   const onSubmit = useKeepValuesSubmit(dispatch);
 *   <form onSubmit={onSubmit}>…</form>
 */
export function useKeepValuesSubmit(dispatch: (formData: FormData) => void) {
  const [, startTransition] = useTransition();
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  };
}
