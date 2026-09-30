"use client";
import { useActionState, useEffect, useRef, useTransition, type FormEvent } from "react";

type ActionResult = { ok: boolean; error?: string; message?: string } | null;

/**
 * Como `useActionState` + `<form action>`, mas NÃO apaga o que a pessoa digitou quando a ação devolve erro
 * (o React 19 reseta o formulário ao concluir a ação). Se der certo e a página não redirecionar, limpa os campos.
 */
export function useKeptForm(action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>) {
  const [state, dispatch] = useActionState<ActionResult, FormData>(action, null);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => { if (state?.ok) ref.current?.reset(); }, [state]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
    start(() => dispatch(data));
  };
  return { state, pending, formProps: { ref, onSubmit } };
}
