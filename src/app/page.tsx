import { redirect } from "next/navigation";

// The dispatch board is the console's landing page.
export default function Home() {
  redirect("/dispatch");
}
