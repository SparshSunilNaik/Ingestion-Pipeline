import { Suspense } from "react";
import { Spinner } from "@/components/ui";
import { JobView } from "./job-view";

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <JobView />
    </Suspense>
  );
}
