// Starter examples, written in the System One request shape.
export const TEMPLATES = [
  {
    name: 'Support ticket triage',
    request: {
      state:
        "Help! My payouts have been failing for 3 days and I've already emailed twice. This is costing us real money.",
      questions: {
        department: {
          type: 'choice',
          instructions: 'Which team should handle this ticket?',
          criteria: {
            billing: 'Payments, payouts, invoicing, refunds',
            technical: 'Bugs, outages, integrations',
            sales: 'Pricing, upgrades, new accounts',
            account: 'Login, permissions, profile changes',
            other: 'Anything else, or unclear',
          },
        },
        is_urgent: {
          type: 'noul',
          instructions: 'Does the customer convey that this is time-sensitive?',
          criteria: { true: 'Explicitly time-sensitive or business-impacting', false: 'No urgency expressed' },
        },
        frustration: {
          type: 'score',
          instructions: 'How frustrated is the customer?',
          criteria: [
            'Calm and neutral',
            'Mildly annoyed but polite',
            'Clearly frustrated, mentions repeated attempts',
            'Very angry, hostile or threatening to leave',
          ],
        },
      },
    },
  },
  {
    name: 'Product review analysis',
    request: {
      state:
        'Battery life is fantastic and the screen is gorgeous, but the app crashed twice during setup and support took a week to reply.',
      questions: {
        sentiment: {
          type: 'score',
          instructions: "How positive is the reviewer's overall opinion?",
          criteria: [
            'Very negative: would not recommend',
            'Negative overall, with minor positives',
            'Mixed: positives and negatives roughly balance',
            'Positive overall, with minor complaints',
            'Very positive: enthusiastic recommendation',
          ],
        },
        mentions_bug: {
          type: 'noul',
          instructions: 'Does the review describe software that crashed, froze, or misbehaved?',
        },
        main_topic: {
          type: 'choice',
          instructions: 'What is the review mostly about?',
          criteria: {
            hardware: 'Physical build, screen, battery',
            software: 'App or firmware behavior',
            support: 'Customer service experience',
            pricing: 'Cost and value',
            other: 'None of the above',
          },
        },
      },
    },
  },
  {
    name: 'Comment moderation',
    request: {
      state: "Honestly this is the dumbest article I've read all week. Whoever wrote it should find a new career.",
      questions: {
        is_spam: {
          type: 'noul',
          instructions: 'Is this comment spam, advertising, or a link-drop?',
        },
        toxicity: {
          type: 'score',
          instructions: 'How hostile is this comment toward a person or group?',
          criteria: [
            'Civil, even if it disagrees',
            'Blunt or harsh about the content, not the person',
            'Insulting toward a person',
            'Threatening, harassing, or hateful',
          ],
        },
        action: {
          type: 'choice',
          instructions: 'What should a community moderator do with this comment?',
          criteria: {
            publish: 'Fine to publish as-is',
            hold_for_review: 'A human should look before it goes live',
            remove: 'Clearly violates community guidelines',
          },
        },
      },
    },
  },
  {
    name: 'Lead qualification',
    request: {
      state:
        "Company: Northwind Logistics (freight, 240 employees)\nMessage: We're replacing our dispatch tooling this quarter and need something live by September.",
      questions: {
        has_timeline: {
          type: 'noul',
          instructions: 'Does the message state a concrete timeframe for a purchase decision?',
        },
        fit: {
          type: 'score',
          instructions: 'How well does this lead match a mid-market software buyer with an active project?',
          criteria: [
            'Poor fit: no project, wrong size',
            'Possible fit: interest but no active project',
            'Good fit: active project, right size',
            'Excellent fit: active project, right size, tight deadline',
          ],
        },
        segment: {
          type: 'choice',
          instructions: "Which sales segment should own this lead, based on the company's employee count?",
          criteria: {
            smb: 'Fewer than 50 employees',
            mid_market: '50 to 999 employees',
            enterprise: '1000 or more employees',
          },
        },
      },
    },
  },
];

// Starter examples for the dedicated Yes / No, Score and Choice pages. Every question on a page has that page's type.
export const TYPE_EXAMPLES = {
  yesno: [
    {
      name: 'Is this a refund request?',
      request: {
        state: 'I was charged twice for the same order. Please send the extra payment back to my card.',
        questions: {
          asks_for_refund: {
            type: 'noul',
            instructions: 'Is the customer asking for their money back?',
            criteria: { true: 'Explicitly asks for a refund or a reversed charge', false: 'Does not ask for money back' },
          },
        },
      },
    },
    {
      name: 'Does the review mention a bug?',
      request: {
        state: 'Love the design, but the app froze twice while I was checking out and I had to restart my phone.',
        questions: {
          mentions_bug: {
            type: 'noul',
            instructions: 'Does the review describe software that crashed, froze, or misbehaved?',
            criteria: { true: 'Describes a crash, freeze, or malfunction', false: 'No software problem described' },
          },
          is_positive: {
            type: 'noul',
            instructions: 'Is the reviewer mostly positive about the product?',
          },
        },
      },
    },
    {
      name: 'A question with no input',
      request: {
        state: '',
        questions: {
          is_capital: { type: 'noul', instructions: 'Is Paris the capital of France?' },
        },
      },
    },
  ],
  score: [
    {
      name: 'How angry is this email?',
      request: {
        state: 'This is the third time I am writing about the same broken login. Nobody has answered and I am done waiting.',
        questions: {
          anger: {
            type: 'score',
            instructions: 'How angry is the writer?',
            criteria: [
              'Calm and neutral',
              'Mildly annoyed but polite',
              'Clearly frustrated, mentions repeated attempts',
              'Very angry, hostile or threatening to leave',
            ],
          },
        },
      },
    },
    {
      name: 'How formal is this message?',
      request: {
        state: 'hey, just checking if u got my invoice yet, thx!',
        questions: {
          formality: {
            type: 'score',
            instructions: 'How formal is the writing style?',
            criteria: [
              'Very casual: slang, abbreviations, no punctuation',
              'Casual but readable, like a chat message',
              'Professional, a normal work email',
              'Very formal, like a legal or official letter',
            ],
          },
        },
      },
    },
  ],
  choice: [
    {
      name: 'Route a support ticket',
      request: {
        state: 'My payouts have been failing for three days and I cannot see why.',
        questions: {
          department: {
            type: 'choice',
            instructions: 'Which team should handle this ticket?',
            criteria: {
              billing: 'Payments, payouts, invoicing, refunds',
              technical: 'Bugs, outages, integrations',
              sales: 'Pricing, upgrades, new accounts',
              other: 'Anything else, or unclear',
            },
          },
        },
      },
    },
    {
      name: 'What does the sender want?',
      request: {
        state: 'Could you send me the latest pricing for the team plan?',
        questions: {
          intent: {
            type: 'choice',
            instructions: 'What is the sender mainly trying to do?',
            criteria: {
              ask_question: 'Wants information or an answer',
              request_action: 'Wants someone to do something',
              complain: 'Is unhappy and wants to say so',
              other: 'None of these, or unclear',
            },
          },
        },
      },
    },
  ],
};

// Starter examples for the Rank page: a query and the candidates to order by how well they fit it.
export const RANK_EXAMPLES = [
  {
    name: 'Which of these could be an effective weapon?',
    query: 'Could this be used as an effective weapon?',
    candidates: [
      'Hot Sauce', 'Grilled Tart', 'Smoked Pasta', 'Fresh Water', 'Raspberry', 'Plain Yogurt', 'Salmon', 'Barley', 'Tempeh',
      'Savory Almond Milk', 'Toasted Raspberry', 'Braised Couscous', 'Baked Brownie', 'Crispy Pear', 'Crispy Hummus',
      'Salted Wine', 'Fried Pudding', 'Pickled Eclair', 'Pickled Walnuts', 'Creamy Chocolate Cake', 'Crispy Butter',
      'Greek Yogurt', 'Spicy Cucumber', 'Roasted Brownie', 'Bagel', 'Chocolate Cake', 'Steamed Pumpkin Seeds',
      'Pickled Cabbage', 'Savory Danish Pastry', 'Pineapple', 'Gourmet Polenta', 'Fresh Date', 'Fresh Venison',
      'Fresh Barley', 'Sparkling Water', 'Almond Milk', 'Homemade Gelato', 'Smoked Peanuts', 'Guacamole', 'Potato',
      'Crispy Whole Wheat Bread', 'Glazed White Bread', 'Braised Coconut Water', 'Gourmet Maple Syrup',
      'Roasted Black Coffee', 'Lemon', 'Danish Pastry', 'Mayonnaise', 'Glazed Croissant', 'Toasted Cauliflower',
      'Fresh Coconut Oil', 'Garlic', 'Pickled Oats', 'Steamed Cider', 'Fresh Peanut Butter', 'Sweet Garlic',
      'Fresh Mackerel', 'Smoked Brown Rice', 'Cod', 'Cashews', 'Grilled Mozzarella', 'Steamed Pancakes', 'Soy Sauce',
      'Salted Danish Pastry', 'Toasted Cabbage', 'Creamy Vinegar', 'Homemade Almond Butter', 'Fried Swiss Cheese',
      'Spicy Granola Bar', 'Fresh Eggplant', 'Pickled Cinnamon Roll', 'Crispy Wine', 'Fried Gelato', 'Tortilla Chips',
      'Fresh Tomato', 'Spicy Pinto Beans', 'Glazed Eggplant', 'Crispy Flatbread', 'Gourmet Apple Pie', 'Creamy Nutella',
      'Glazed Bulgur', 'Organic Black Coffee', 'Grilled Eggplant', 'Maple Syrup', 'Pickled Egg', 'Baked Spaghetti',
      'Gourmet Hot Sauce', 'Hot coffee',
    ],
  },
];

// Starter examples for the Batch page: the questions (Batch runs the Single page's questions) and the items to run
// them on. An item may carry `expected` answers, which the Accuracy check compares Jev against: "yes"/"no" for a
// Yes / No question, an option key for a Choice, a level number for a Score.
export const BATCH_EXAMPLES = [
  {
    name: 'Support tickets, with expected answers',
    questions: TEMPLATES[0].request.questions,
    items: [
      { text: "My payouts have been failing for 3 days and I've emailed twice. This is costing us real money.", expected: { department: 'billing', is_urgent: 'yes', frustration: '2' } },
      { text: 'How much does the enterprise plan cost for 200 seats?', expected: { department: 'sales', is_urgent: 'no', frustration: '0' } },
      { text: "I can't log in after resetting my password, the link says it has expired.", expected: { department: 'account', is_urgent: 'no', frustration: '1' } },
      { text: 'The API has returned 500 errors on every request since this morning!!', expected: { department: 'technical', is_urgent: 'yes', frustration: '2' } },
      { text: "Please send me a copy of last month's invoice when you get a chance.", expected: { department: 'billing', is_urgent: 'no', frustration: '0' } },
      { text: "Your app just deleted all my data and nobody is answering. I'm cancelling my account.", expected: { department: 'technical', is_urgent: 'yes', frustration: '3' } },
      { text: 'Can I add two more users to my team plan?', expected: { department: 'sales', is_urgent: 'no', frustration: '0' } },
      { text: 'Thanks for the quick fix yesterday, everything works now.', expected: { department: 'other', is_urgent: 'no', frustration: '0' } },
      { text: 'I was charged twice for the same subscription this month.', expected: { department: 'billing', frustration: '1' } },
      { text: 'Webhooks stopped arriving an hour ago and our checkout depends on them.', expected: { department: 'technical', is_urgent: 'yes', frustration: '2' } },
      { text: 'Do you offer a discount for non-profit organizations?', expected: { department: 'sales', is_urgent: 'no', frustration: '0' } },
      { text: 'I need to change the email address on my account.', expected: { department: 'account', is_urgent: 'no', frustration: '0' } },
      { text: 'The reports page loads a little slowly when I open it.', expected: { department: 'technical', is_urgent: 'no', frustration: '1' } },
      { text: 'URGENT: our whole team is locked out and we have a launch in one hour.', expected: { department: 'account', is_urgent: 'yes', frustration: '2' } },
    ],
  },
  {
    name: 'Product reviews',
    questions: TEMPLATES[1].request.questions,
    items: [
      { text: 'Battery life is fantastic and the screen is gorgeous, but the app crashed twice during setup.' },
      { text: 'Arrived on time and works exactly as described. Very happy with it.' },
      { text: 'The strap broke after two weeks and support took ten days to answer my email.' },
      { text: 'Too expensive for what it offers, and the software keeps freezing.' },
      { text: 'Great build quality. I wish it came with a charger, but otherwise no complaints.' },
      { text: 'The firmware update bricked my device. Customer service was polite but could not fix it.' },
      { text: 'Excellent value for the price, the speakers are surprisingly loud and clear.' },
      { text: 'It is fine. Does the job, nothing special.' },
      { text: 'The companion app is confusing and keeps logging me out, though the hardware itself is solid.' },
      { text: 'Support replied within an hour and replaced my faulty unit the same day. Impressed.' },
    ],
  },
];

// Questions to try on the Wikipedia answer page. Mercury is a good one to watch: it is a planet, an element and a god.
export const WIKIPEDIA_EXAMPLES = [
  { name: 'How big is Paris?', question: 'How big is Paris?' },
  { name: 'How tall is Mount Everest?', question: 'How tall is Mount Everest?' },
  { name: 'Who wrote Frankenstein?', question: 'Who wrote Frankenstein?' },
  { name: 'When was the Eiffel Tower finished?', question: 'When was the Eiffel Tower finished?' },
  { name: 'How old is Mercury? (planet, element or god)', question: 'How old is Mercury?' },
];

// Games to try on the Steam page. Each is just a store link; the game's name is read from it.
export const STEAM_EXAMPLES = [
  { name: 'Deep Rock Galactic', url: 'https://store.steampowered.com/app/548430/Deep_Rock_Galactic/' },
  { name: 'Cyberpunk 2077', url: 'https://store.steampowered.com/app/1091500/Cyberpunk_2077/' },
  { name: 'Helldivers 2', url: 'https://store.steampowered.com/app/553850/HELLDIVERS_2/' },
];
