"use client";

import { Boxes } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { useAsync, usePref } from "@/lib/hooks";
import { EmptyState, Spinner } from "@/components/ui";

/** Opens the last workspace, else the most recently analysed repository. */
export default function WorkspaceRedirect() {
  const router = useRouter();
  const [last] = usePref("ip.lastSnapshot", "");
  const repos = useAsync(() => (last ? Promise.resolve(null) : api.repositories()), [last]);
  const target = last || repos.data?.find((r) => r.current)?.current?.id;
  useEffect(() => {
    if (target) router.replace(`/snapshots/${target}`);
  }, [target, router]);
  if (!target && repos.data)
    return <EmptyState icon={<Boxes className="h-6 w-6" />} title="No analysed repository yet" action={<Link className="text-accent hover:underline" href="/">Analyse one from the dashboard</Link>} />;
  return <div className="p-6"><Spinner label="Opening workspace" /></div>;
}
