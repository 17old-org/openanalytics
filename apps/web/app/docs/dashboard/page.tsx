import {
  Code,
  DocArticle,
  DocCode,
  DocHeading,
  DocLink,
  DocList,
  DocNote,
  DocSection,
  DocTable,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("dashboard");
export const metadata = docsMetadata(page);

export default function DashboardDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="How the overview reads">
        <p>
          A site&apos;s overview reads top to bottom. The headline totals come
          first (visitors, pageviews, bounce rate, average visit), then the
          traffic chart, then the breakdowns: pages, sources, geography,
          devices and custom events. Every number answers the range picked in
          the header, and every breakdown is that same range cut a different
          way, so nothing on the page is measuring a different window than
          anything else.
        </p>
      </DocSection>

      <DocSection title="The headline numbers">
        <DocTable
          head={["Metric", "What it counts"]}
          rows={[
            [
              "Visitors",
              "Unique people in the range, counted with the daily-rotating identifier. Never summed from days, so a 30-day count is not the sum of 30 daily counts.",
            ],
            ["Pageviews", "Every page load and client-side route change."],
            [
              "Bounce rate",
              "The share of sessions with a single interaction, rebuilt server-side from the 30-minute session rule.",
            ],
            [
              "Average visit",
              "Mean session duration, from engagement time rather than raw tab-open time.",
            ],
          ]}
        />
      </DocSection>

      <DocSection title="The breakdowns">
        <DocHeading>Pages</DocHeading>
        <p>
          Top paths by pageviews, with entries and exits, so you can see where
          people land and where they leave. The column you rank by is a
          question put to the server, not a re-sort of the rows on screen: a
          top-100-by-views page re-sorted by exits would present that
          page&apos;s biggest exits as the site&apos;s biggest.
        </p>
        <DocHeading>Sources</DocHeading>
        <p>
          Where visits come from, canonicalised: your own domain is dropped as
          a referrer, and hosts are folded to a channel name with a favicon, so
          Google&apos;s many subdomains read as one Google. Visits that arrive
          with no referrer at all read as Direct &mdash; tagging your links
          (just below) is how you give those a name. See{" "}
          <DocLink slug="troubleshooting">troubleshooting</DocLink> if a number
          looks lower than another tool&apos;s.
        </p>
        <DocHeading>Geography and devices</DocHeading>
        <p>
          Country-level geography from a privacy-preserving lookup, and device,
          browser and OS breakdowns, each over the same range.
        </p>
        <DocHeading>Custom events</DocHeading>
        <p>
          The events you defined, with counts, when they last fired and a
          sample of their properties. See{" "}
          <DocLink slug="custom-events">custom events</DocLink> to add them.
        </p>
        <DocHeading>Filtering by a row</DocHeading>
        <p>
          Clicking a row in Sources, Locations or the device cards keeps only
          the sessions that match it, and the rest of the overview re-reads
          with that filter applied. There is no separate filter picker: the row
          is the door, which is why its name underlines under the pointer. What
          you have picked appears as marks on the bar at the bottom of the
          screen &mdash; a favicon, a flag, a device glyph &mdash; and each
          mark clears on its own.
        </p>
        <DocList
          items={[
            "A filter selects sessions, and the report then describes everything those sessions did. Keeping the visits from Google shows every page they went on to read, not only the page they landed on.",
            "Two picks in one breakdown mean either (Google or GitHub); picks in two breakdowns mean both (Google and mobile).",
            "The four things you can filter by are all about the visit rather than the page: source, country, city and device. Pages are deliberately not one of them, because “filter by page” would have to choose between the sessions that touched a page and the pageviews of it, and those are different questions.",
            "Custom events and performance answer the range but not the filter, and leave the marks alone rather than pretending to narrow.",
          ]}
        />
        <DocNote>
          A filtered view is rebuilt from raw events rather than read off a
          rollup, so it covers at most 92 days where the unfiltered report
          answers a year. Past that the cards say so and offer the two ways
          out: shorten the range, or drop the filters and keep it.
        </DocNote>
      </DocSection>

      <DocSection title="Tag your own links">
        <p>
          Browsers send less and less referrer information every year, and
          some places send none at all &mdash; a link in a newsletter, a PDF,
          a chat app or an app&apos;s in-built browser usually arrives with
          nothing attached, which is why so much traffic reads as Direct.
          Adding a <Code>ref</Code> to the link fixes that, and there is
          nothing to turn on: if a visit arrives with no referrer of its own,
          the tag names the source.
        </p>
        <DocCode caption="Any link you control">{`https://example.com/?ref=twitter
https://example.com/pricing?ref=newsletter`}</DocCode>
        <DocList
          items={[
            "Known names are folded onto the site they mean, so ?ref=twitter lands in the same row as the visits X reports itself. A domain works too: ?ref=selfh.st.",
            "Anything else is kept exactly as you wrote it, so ?ref=newsletter is its own row in Sources — useful for the places that have no domain at all.",
            "A referrer the browser did send always wins. The tag only fills in what would otherwise be Direct, so a leftover ?ref on your own internal links cannot invent a visit.",
          ]}
        />
        <DocNote>
          Many sites already do this for you: Product Hunt appends{" "}
          <Code>?ref=producthunt</Code> to every outbound link, and so do most
          launch boards, directories and newsletters &mdash; those visits stop
          reading as Direct on their own. <Code>ref</Code> and UTM tags answer
          different questions and do not compete: <Code>utm_source</Code> and
          its companions are their own cuts of the Sources card, for campaigns
          you are running and measuring, while <Code>ref</Code> is a light way
          to name where a single link lives. A link may carry both. Tagging is
          only read going forward &mdash; it cannot relabel visits that already
          happened.
        </DocNote>
      </DocSection>

      <DocSection title="Ranges and comparisons">
        <DocList
          items={[
            "The interval picker covers today, yesterday, the last 7 and 30 days, month and year views, 6 and 12 months, and All time (anchored at your site's first event).",
            "Comparisons show the preceding equal-length period beside the current one, so a delta is always against something concrete.",
            "The chart picks its own grain honestly: hours for a day, days for a month, ISO weeks for 6 and 12 months. Weekly unique visitors are merged server-side, never summed from days, so uniques stay true.",
          ]}
        />
      </DocSection>

      <DocSection title="Whose clock cuts the day">
        <p>
          Charts follow your account timezone (or your browser&apos;s, until
          you pick one), so Today means your today. Widgets and public
          share pages have their own rules; the{" "}
          <DocLink slug="timezones">timezones page</DocLink> lays out all
          three clocks.
        </p>
      </DocSection>

      <DocSection title="Sessions and engagement">
        <p>
          A session is rebuilt server-side with a 30-minute inactivity rule;
          bounce rate and average visit duration come from it. Engagement
          time is measured with two clocks (visible time, and active time
          near a real interaction), so a tab parked in the background does
          not inflate anything.
        </p>
      </DocSection>

      <DocSection title="Freshness">
        <DocNote>
          Events typically land in charts within seconds. When the chip
          beside a card&apos;s title says Catching up, the pipeline is behind
          and the charts are honest about it; a site with no traffic simply
          shows its last visit&apos;s age. For the current moment, the{" "}
          <DocLink slug="realtime">realtime view</DocLink> is the faster
          surface.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
