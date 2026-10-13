import { catalogPhoto } from "@centralops/domain";

/** Foto do catálogo para o navegador: bucket público do Storage (cópia guardada) ou link do site, enquanto não foi copiada. */
export function photoUrl(pathOrUrl: string, width: number | null = null): string {
  return catalogPhoto(pathOrUrl, width, process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}
