import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { groups } from "./src/data/plugins.mjs";

export default defineConfig({
  site: "https://pi-plugins.vercel.app",
  output: "static",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Pi Plugins",
      description: "Spencer Boucher’s personal collection of focused extensions for Pi. Background work, thoughtful review and a better terminal.",
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/justmytwospence/pi-plugins" }],
      editLink: { baseUrl: "https://github.com/justmytwospence/pi-plugins/edit/main/site/" },
      customCss: ["./src/styles/custom.css"],
      components: { Hero: "./src/components/Hero.astro", Footer: "./src/components/Footer.astro" },
      sidebar: [
        { label: "Start here", items: [
          { label: "Overview", slug: "guides/overview" },
          { label: "Install & select", slug: "guides/install" },
          { label: "Pin, update & rollback", slug: "guides/releases" },
          { label: "Requirements & costs", slug: "guides/requirements" },
          { label: "Keymap & focus", slug: "guides/keyboard" },
          { label: "Standalone & compatibility", slug: "guides/standalone" },
          { label: "External packages", slug: "guides/external" },
          { label: "Troubleshooting & conflicts", slug: "guides/troubleshooting" },
        ] },
        { label: "Workflow recipes", items: [
          { label: "Background work & subagents", slug: "recipes/background-work" },
          { label: "Notebook sessions", slug: "recipes/notebooks" },
          { label: "Plan, implement, review", slug: "recipes/plan-review" },
          { label: "Manage context & cost", slug: "recipes/cache-cost" },
        ] },
        ...groups.map((group) => ({ label: group.title, collapsed: true, items: group.plugins.map((plugin) => ({ label: plugin.name, slug: "plugins/" + plugin.name })) })),
        { label: "Under the hood", items: [
          { label: "Activity & lifecycle", slug: "architecture/activity" },
          { label: "Development & testing", slug: "development" },
          { label: "About & credits", slug: "about" },
        ] },
      ],
      head: [
        { tag: "meta", attrs: { name: "theme-color", content: "#2449d8" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://pi-plugins.vercel.app/social.svg" } },
        { tag: "meta", attrs: { name: "author", content: "Spencer Boucher" } },
      ],
    }),
  ],
});
