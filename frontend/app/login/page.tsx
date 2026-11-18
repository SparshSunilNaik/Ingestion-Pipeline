import { Suspense } from "react";
import { LoginView } from "./login-view";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoginView />
    </Suspense>
  );
}
