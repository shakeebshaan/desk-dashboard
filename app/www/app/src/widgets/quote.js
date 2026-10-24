// Quote and word of the day: chosen by the date from lists built into the UI (no network, no API).
// Quotes are old and in the public domain; the word definitions are written for this dashboard.
const QUOTES = [
  ["Well begun is half done.", "Aristotle"],
  ["The journey of a thousand miles begins with one step.", "Lao Tzu"],
  ["Knowing yourself is the beginning of all wisdom.", "Aristotle"],
  ["He who has a why to live can bear almost any how.", "Friedrich Nietzsche"],
  ["The best time to plant a tree was twenty years ago. The second best time is now.", "Proverb"],
  ["Patience is bitter, but its fruit is sweet.", "Jean-Jacques Rousseau"],
  ["What you seek is seeking you.", "Rumi"],
  ["Be kind, for whoever you meet is fighting a hard battle.", "Ian Maclaren"],
  ["It does not matter how slowly you go as long as you do not stop.", "Confucius"],
  ["Little by little, one travels far.", "Proverb"],
  ["The greatest wealth is to live content with little.", "Plato"],
  ["Waste no more time arguing what a good man should be. Be one.", "Marcus Aurelius"],
  ["The more that you read, the more things you will know.", "Proverb"],
  ["A smooth sea never made a skilled sailor.", "Proverb"],
  ["Do what you can, with what you have, where you are.", "Theodore Roosevelt"],
  ["Happiness depends upon ourselves.", "Aristotle"],
  ["Who is rich? The one who is happy with his lot.", "Pirkei Avot"],
  ["The wound is the place where the light enters you.", "Rumi"],
  ["Well done is better than well said.", "Benjamin Franklin"],
  ["An investment in knowledge pays the best interest.", "Benjamin Franklin"],
  ["Nothing is impossible to a willing heart.", "John Heywood"],
  ["Every child is an artist.", "Pablo Picasso"],
  ["The secret of getting ahead is getting started.", "Proverb"],
  ["We are what we repeatedly do.", "Will Durant, after Aristotle"],
  ["Gratitude turns what we have into enough.", "Proverb"],
  ["A calm mind brings inner strength.", "Proverb"],
  ["Seek knowledge from the cradle to the grave.", "Proverb"],
  ["The pen is mightier than the sword.", "Edward Bulwer-Lytton"],
  ["Kind words do not cost much, yet they accomplish much.", "Blaise Pascal"],
  ["Simplicity is the ultimate sophistication.", "Proverb"],
  ["Where there is love there is life.", "Mahatma Gandhi"],
  ["The best of you are those who are best to their families.", "Hadith (Tirmidhi)"],
  ["Make things easy, do not make them hard.", "Hadith (Bukhari)"],
  ["A good word is charity.", "Hadith (Bukhari)"],
  ["Time and tide wait for no man.", "Proverb"],
  ["Rest is not idleness.", "John Lubbock"],
];

const WORDS = [
  ["serendipity", "noun", "finding something good without looking for it", "Meeting an old friend at the station was pure serendipity."],
  ["resilient", "adjective", "able to recover quickly from difficulty", "Kids are resilient: one scraped knee, two minutes of tears."],
  ["ephemeral", "adjective", "lasting a very short time", "The sunset colours were ephemeral, gone in ten minutes."],
  ["candid", "adjective", "honest and direct", "Thanks for the candid answer."],
  ["meticulous", "adjective", "very careful about every detail", "She keeps meticulous notes of every trip."],
  ["benevolent", "adjective", "kind and wanting to help", "A benevolent neighbour fixed our gate."],
  ["eloquent", "adjective", "speaking well and persuasively", "His short speech was eloquent."],
  ["tenacious", "adjective", "not giving up easily", "A tenacious toddler will open any drawer."],
  ["gregarious", "adjective", "liking the company of others", "Our gregarious cousin knows everyone at the wedding."],
  ["frugal", "adjective", "careful not to waste money", "A frugal month leaves room for the trip."],
  ["nostalgia", "noun", "a fond longing for the past", "The old photos filled the room with nostalgia."],
  ["diligent", "adjective", "working hard and carefully", "A diligent student finishes homework first."],
  ["lucid", "adjective", "clear and easy to understand", "Her explanation was lucid."],
  ["ubiquitous", "adjective", "found everywhere", "Phones are ubiquitous now."],
  ["zeal", "noun", "great energy for a cause or goal", "He cleaned the garage with zeal."],
  ["pragmatic", "adjective", "dealing with things sensibly and practically", "A pragmatic plan beats a perfect one."],
  ["empathy", "noun", "understanding how someone else feels", "Empathy makes a good friend."],
  ["vivid", "adjective", "bright and clear, easy to picture", "She told a vivid story about the monsoon."],
  ["humble", "adjective", "not proud; modest", "He stayed humble after the award."],
  ["curious", "adjective", "eager to know or learn", "A curious mind asks why."],
  ["ponder", "verb", "to think about carefully", "Ponder the question before you answer."],
  ["savour", "verb", "to enjoy something slowly", "Savour the first cup of tea."],
  ["thrive", "verb", "to grow and do well", "Plants thrive by the window."],
  ["solace", "noun", "comfort in a sad time", "Music gave him solace."],
  ["luminous", "adjective", "giving off light; glowing", "The luminous moon lit the courtyard."],
  ["kindred", "adjective", "similar in nature or interest", "We found kindred spirits at the book club."],
  ["steadfast", "adjective", "firm and not changing", "A steadfast friend stays."],
  ["wanderlust", "noun", "a strong wish to travel", "Wanderlust hits every December."],
  ["mellifluous", "adjective", "sweet and smooth to hear", "Her mellifluous voice calmed the baby."],
  ["sanguine", "adjective", "hopeful and cheerful", "He stayed sanguine about the results."],
];

const dayIndex = (d = new Date()) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function ofTheDay(d = new Date()) {
  const n = dayIndex(d);
  return { quote: QUOTES[n % QUOTES.length], word: WORDS[(n * 7) % WORDS.length] };
}

export default {
  type: "quote",
  title: "Of the day",
  mount(el) {
    let day = -1;
    const render = () => {
      if (dayIndex() === day) return;
      day = dayIndex();
      const { quote, word } = ofTheDay();
      el.innerHTML = `
        <div class="qt">
          <div class="qt-mark">“</div>
          <blockquote>${quote[0].split(" ").map((w, i) => `<span class="qw" style="animation-delay:${(0.25 + i * 0.07).toFixed(2)}s">${esc(w)}</span>`).join(" ")}</blockquote>
          <cite>${esc(quote[1])}</cite>
        </div>
        <div class="wd">
          <small>Word of the day</small>
          <div class="wd-word"><span class="wl">${[...word[0]].map((c, i) => `<span style="animation-delay:${(0.9 + i * 0.05).toFixed(2)}s">${esc(c)}</span>`).join("")}</span> <i>${esc(word[1])}</i></div>
          <div class="wd-def">${esc(word[2])}</div>
          <div class="wd-ex">“${esc(word[3])}”</div>
        </div>`;
    };
    return { update: render, tick: render };
  },
};
