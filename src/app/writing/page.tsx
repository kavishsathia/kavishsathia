import Link from "next/link";
import { getAllPosts } from "@/lib/blog";

export const metadata = {
  title: "Writing | Kavish Sathia",
};

export default function BlogIndex() {
  const posts = getAllPosts();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto max-w-2xl px-6 py-24 sm:py-32">
        <Link
          href="/"
          className="font-mono text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; back
        </Link>

        <h1 className="font-mono text-sm tracking-wider text-muted mt-12 mb-12">
          WRITING
        </h1>

        {posts.length === 0 ? (
          <p className="text-muted">Nothing here yet.</p>
        ) : (
          <div className="space-y-10">
            {posts.map((post) => (
              <article key={post.slug}>
                <Link href={`/writing/${post.slug}`} className="group block">
                  <time className="font-mono text-xs text-muted">
                    {post.date}
                  </time>
                  <h2 className="text-xl font-medium mt-1 group-hover:underline underline-offset-4">
                    {post.title}
                  </h2>
                  {post.subtitle && (
                    <p className="text-sm text-muted mt-1">{post.subtitle}</p>
                  )}
                </Link>
              </article>
            ))}
          </div>
        )}

        <div className="mt-24 flex justify-end">
          <span className="text-muted text-lg">∎</span>
        </div>
      </main>
    </div>
  );
}
