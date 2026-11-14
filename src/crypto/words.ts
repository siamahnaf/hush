import { randomInt } from "node:crypto";

const WORDS = `acorn adapt agent alarm album alert alpha amber angle apple april arena armor arrow atlas attic audio autumn award bacon
badge bagel baker bamboo banjo barn basil beach beacon bench berry bison blade blank blaze bloom board bonus brave bread brick
bridge brook brush bucket buddy cabin cable cactus camel candle canoe canvas cargo carpet castle cedar chalk charm cherry chess
chief cider cinema circle citrus clay cliff clock cloud clover coast cobalt cocoa comet coral cotton cousin crane crayon creek
crown crystal cubic curtain daisy dance delta denim desert diary dinner dock dolphin donut dragon dream drift eagle early earth
echo elbow ember empire engine falcon fable fancy feather fern ferry fiber field finch flame flute focus forest fossil fox frost
galaxy garden garlic gecko giant ginger glacier globe glove gold grape gravel harbor hazel heron hollow honey horizon hotel igloo
island ivory jacket jade jaguar jelly jigsaw jungle kayak kernel kettle kiwi koala ladder lagoon lantern lava lemon letter lilac
linen lizard lobby lotus lunar magnet mango maple marble meadow melon metro mint mirror mocha monkey mosaic motor muffin nectar
needle nickel noodle novel oasis ocean olive onion opal orbit orchid otter oyster paddle palm panda paper parade pastel peach
pebble pepper piano pilot pixel planet plum polar poppy prism puzzle quartz quiet rabbit radar raven reef ribbon river robin
rocket saddle salmon sandal scarf shadow silver sketch solar spice spruce squid stone sugar summit sunset swan tango temple
thunder tiger timber toast topaz tulip tundra turtle umbrella valley velvet violet walnut willow winter yogurt zebra zephyr`
  .split(/\s+/)
  .filter(Boolean);

export function generatePassphrase(count = 7): string {
  return Array.from({ length: count }, () => WORDS[randomInt(WORDS.length)]).join("-");
}
