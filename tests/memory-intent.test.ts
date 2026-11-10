import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explicitIntent } from '../server/modules/memory/text.js';

test('"onthoud dat …" keeps only the fact: first sentence, no follow-up instruction, main-clause word order', () => {
  const cases: [string, string][] = [
    ['Onthoud dat mijn favoriete kleur oranje is. Zoek daarna op internet wat de hoofdstad van Australië is en antwoord in één zin.', 'Mijn favoriete kleur is oranje'],
    ['onthoud dat ik in Utrecht woon', 'Ik woon in Utrecht'],
    ['Onthoud dat mijn tante Anna heet en zoek dan haar verjaardag op', 'Mijn tante heet Anna'],
    ['onthoud: de leverancier van banden is Van den Ban, daarna wil ik een overzicht', 'De leverancier van banden is Van den Ban'],
    ['Kun je onthouden dat de oude auto rood is?', 'De oude auto is rood'],
    ['Remember that my dog is called Rex and then search for dog food', 'My dog is called Rex'],
    // coordinated clauses share their subject (found in the core acceptance test)
    ['onthoud dat mijn webshop Velomax heet en in Arnhem zit', 'Mijn webshop heet Velomax en zit in Arnhem'],
    ['onthoud dat de leverancier Van den Ban heet en elke maandag levert', 'De leverancier heet Van den Ban en levert elke maandag'],
    ['onthoud dat ik in Utrecht woon en bij FietsShop werk', 'Ik woon in Utrecht en werk bij FietsShop'],
    ['onthoud dat mijn klant Jan uit Gouda komt', 'Mijn klant Jan komt uit Gouda'],
    ['onthoud dat het wachtwoord van de wifi niet gedeeld wordt', 'Het wachtwoord van de wifi wordt niet gedeeld'],
    ['onthoud dat ik graag koffie zwart drink', 'Ik drink graag koffie zwart'],
    // round-2 acceptance test: a nested clause, "ook", and who the fact is for are not mangled into the fact
    ['Onthoud ook dat mijn zus Lisa heet en in Utrecht woont omdat ze daar studeert.', 'Mijn zus heet Lisa en woont in Utrecht, omdat ze daar studeert'],
    ['Onthoud voor al mijn bots (gedeeld geheugen): ons gezin heeft een hond die Bram heet. Gebruik scope shared.', 'Ons gezin heeft een hond die Bram heet'],
    ['Onthoud alleen voor jezelf, niet voor mijn andere bots: ik wil op vrijdag altijd vis eten.', 'Ik wil op vrijdag altijd vis eten'],
    ['Onthoud voor al mijn bots dat ik op maandag vrij ben.', 'Ik ben op maandag vrij'],
    ['onthoud dat ik als kind in Gouda woonde', 'Ik woonde als kind in Gouda'],
  ];
  for (const [input, want] of cases) assert.deepEqual(explicitIntent(input), { kind: 'remember', content: want }, input);
  assert.deepEqual(explicitIntent('onthoud dit'), { kind: 'remember', content: '' });
  assert.deepEqual(explicitIntent('onthoud dit niet'), { kind: 'no_remember' });
  // "Only in this conversation" is not a long-term memory (round-2 acceptance: another chat saw a note about it).
  assert.deepEqual(explicitIntent('Onthoud alleen in dit gesprek het codewoord ANANAS. Antwoord met "ok".'), { kind: 'no_remember' });
  assert.deepEqual(explicitIntent('Remember the code word only for this chat'), { kind: 'no_remember' });
});
