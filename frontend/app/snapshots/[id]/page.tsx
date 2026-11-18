import { Suspense } from "react";
import { Spinner } from "@/components/ui";
import { WorkspaceView } from "./workspace-view";

export default function Page() {
  return (
    <Suspense fallback={<Spinner label="Loading workspace" />}>
      <WorkspaceView />
    </Suspense>
  );
}
