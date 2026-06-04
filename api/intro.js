const { INTRO_MESSAGE } = require('../lib/prompt');

// Returns Vee's intro message instantly — no AI call needed.
// Called once by the frontend when the chat widget opens.
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.status(200).json({ message: INTRO_MESSAGE });
}
