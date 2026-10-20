import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Summit Air</h1>
      <p className="max-w-md text-muted-foreground">
        AI phone agent backend for residential heating and cooling in Brooklyn, Queens and Staten Island.
        The staff dashboard is coming soon.
      </p>
      <Button nativeButton={false} render={<a href="/api/health" />} variant="outline">
        System health
      </Button>
    </main>
  );
}
