// Redistributable, deterministic sample content. These are source preview fixtures.
export const documents = [
  {
    id: 'kickoff', title: 'Project kickoff', description: 'A short brief with headings and a list.',
    blocks: [
      { text: 'A quieter workspace', heading: 1 },
      { text: 'Project kickoff · October 2026' },
      { text: 'The idea', heading: 2 },
      { text: 'Give small teams a calm place to think, write, and turn a first draft into something useful.', bold: 'calm place' },
      { text: 'What we want to build', heading: 2 },
      { text: 'A document that opens quickly and feels good to edit.', list: true },
      { text: 'Clear decisions, with enough context for the next person.', list: true },
      { text: 'Small examples that make the product easy to understand.', list: true },
      { text: 'Next step', heading: 2 },
      { text: 'Use this page as a first draft. Add a sentence, change a heading, or replace this paragraph with your own plan.' },
    ],
  },
  {
    id: 'bug-report', title: 'Bug report', description: 'A focused ticket ready for your details.',
    blocks: [
      { text: 'The search field loses focus', heading: 1 },
      { text: 'A sample ticket for a fictional application. Replace the details with a bug you want to investigate.' },
      { text: 'Steps to reproduce', heading: 2 },
      { text: 'Open the project list.', list: true },
      { text: 'Type “workshop” in the search field.', list: true },
      { text: 'Wait for the list to refresh, then continue typing.', list: true },
      { text: 'Expected result', heading: 2 },
      { text: 'The search field keeps focus and the next character appears in the query.', bold: 'keeps focus' },
      { text: 'Actual result', heading: 2 },
      { text: 'Focus moves to the page. The next character is lost.' },
    ],
  },
  {
    id: 'meeting-notes', title: 'Meeting notes', description: 'Decisions and next steps in one page.',
    blocks: [
      { text: 'Monday design review', heading: 1 },
      { text: 'Attendees: Alex, Sam, and Robin' },
      { text: 'What we discussed', heading: 2 },
      { text: 'The first experience should start with a useful document. A blank page can come later.' },
      { text: 'Decision', heading: 2 },
      { text: 'Start with three examples and let people edit them immediately.', bold: 'three examples' },
      { text: 'Next steps', heading: 2 },
      { text: 'Alex: draft the sample documents.', list: true },
      { text: 'Sam: check keyboard navigation and small screens.', list: true },
      { text: 'Robin: collect feedback from the first readers.', list: true },
    ],
  },
];
