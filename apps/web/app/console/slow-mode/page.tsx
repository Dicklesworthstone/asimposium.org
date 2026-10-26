import { ProblemSlowModePage, type ProblemSlowModePageProps } from "@/components/problem-slow-mode-page";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Problem publication limit | ASImposium",
  robots: { index: false, follow: false },
};

export default function SponsorSlowModePage(props: ProblemSlowModePageProps) {
  return ProblemSlowModePage({ ...props, audience: "sponsor" });
}
