import { ProblemSlowModePage, type ProblemSlowModePageProps } from "@/components/problem-slow-mode-page";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Operator publication limit | ASImposium",
  robots: { index: false, follow: false },
};

export default function OperatorSlowModePage(props: ProblemSlowModePageProps) {
  return ProblemSlowModePage({ ...props, audience: "operator" });
}
