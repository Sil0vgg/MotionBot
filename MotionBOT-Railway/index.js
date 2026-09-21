require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN) {
    console.error("Missing DISCORD_TOKEN in .env");
    process.exit(1);
}

if (!CLIENT_ID) {
    console.error("Missing CLIENT_ID in .env");
    process.exit(1);
}

const DATA_FILE = path.join(__dirname, "motionbot-data.json");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

// ============================================================
// DATA
// ============================================================

let data = {
    warnings: {},
    challenges: {},
    events: {},
    settings: {}
};

try {
    if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

        data = {
            warnings: parsed.warnings || {},
            challenges: parsed.challenges || {},
            events: parsed.events || {},
            settings: parsed.settings || {}
        };
    }
} catch (error) {
    console.error("Failed to load data:", error.message);
}

let saveTimer = null;

function saveData() {
    if (saveTimer) return;

    saveTimer = setTimeout(() => {
        saveTimer = null;

        try {
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(data, null, 2),
                "utf8"
            );
        } catch (error) {
            console.error("Failed to save data:", error.message);
        }
    }, 1500);
}

// ============================================================
// HELPERS
// ============================================================

function truncate(text, length = 1000) {
    if (!text) return "None";
    text = String(text);

    if (text.length <= length) return text;

    return text.slice(0, length - 3) + "...";
}

function formatDuration(seconds) {
    seconds = Math.floor(seconds);

    const days = Math.floor(seconds / 86400);
    seconds %= 86400;

    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;

    const minutes = Math.floor(seconds / 60);
    seconds %= 60;

    const parts = [];

    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(" ");
}

function safeUserName(user) {
    return user.globalName || user.username;
}

function getWarnings(guildId, userId) {
    if (!data.warnings[guildId]) {
        data.warnings[guildId] = {};
    }

    if (!data.warnings[guildId][userId]) {
        data.warnings[guildId][userId] = [];
    }

    return data.warnings[guildId][userId];
}

function randomItem(array) {
    return array[Math.floor(Math.random() * array.length)];
}

function difficultyEmoji(difficulty) {
    const value = String(difficulty || "").toLowerCase();

    if (value.includes("easy")) return "🟢";
    if (value.includes("normal")) return "🔵";
    if (value.includes("harder")) return "🟠";
    if (value === "hard") return "🟡";
    if (value.includes("insane")) return "🔴";
    if (value.includes("demon")) return "😈";
    if (value.includes("auto")) return "⚪";

    return "⚫";
}

function difficultyName(level) {
    if (!level) return "Unknown";

    if (level.difficulty) return level.difficulty;

    if (level.difficultyFace) {
        return level.difficultyFace;
    }

    return "Unknown";
}

function levelUrl(id) {
    return `https://gdbrowser.com/${id}`;
}

// ============================================================
// GEOMETRY DASH API
// ============================================================
//
// GDBrowser does not require an API key.
// However, it can return 403 from hosting providers/datacenter IPs.
//
// We therefore:
// 1. Cache successful responses.
// 2. Cache failures briefly.
// 3. Retry through the secondary public API.
// 4. Never spam Wispbyte with requests.
// ============================================================

const GD_BROWSER_API = "https://gdbrowser.com/api";
const GD_ALT_API = "https://gd-level-api.liamt.xyz";

const GD_CACHE_TIME = 60 * 1000;
const GD_FAILURE_CACHE_TIME = 15 * 1000;
const GD_TIMEOUT = 7000;

const gdCache = new Map();
const gdFailureCache = new Map();

let gdbrowserBlocked = false;
let gdbrowserBlockedUntil = 0;

async function fetchJSON(url, options = {}) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, GD_TIMEOUT);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                "User-Agent": "MotionBOT/3.0 Discord Bot",
                "Accept": "application/json",
                ...(options.headers || {})
            }
        });

        const text = await response.text();

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.body = text;
            throw error;
        }

        if (!text || text.trim() === "-1") {
            return null;
        }

        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    } finally {
        clearTimeout(timeout);
    }
}

async function gdbrowserFetch(endpoint) {
    const cached = gdCache.get(`gdb:${endpoint}`);

    if (
        cached &&
        Date.now() - cached.time < GD_CACHE_TIME
    ) {
        return cached.data;
    }

    const failure = gdFailureCache.get(`gdb:${endpoint}`);

    if (
        failure &&
        Date.now() - failure < GD_FAILURE_CACHE_TIME
    ) {
        return null;
    }

    if (gdbrowserBlocked && Date.now() < gdbrowserBlockedUntil) {
        return null;
    }

    try {
        const result = await fetchJSON(
            `${GD_BROWSER_API}${endpoint}`
        );

        if (result !== null) {
            gdCache.set(`gdb:${endpoint}`, {
                data: result,
                time: Date.now()
            });

            return result;
        }

        return null;
    } catch (error) {
        if (error.status === 403) {
            gdbrowserBlocked = true;
            gdbrowserBlockedUntil =
                Date.now() + 5 * 60 * 1000;

            console.warn(
                "GDBrowser returned 403. Temporarily disabling direct GDBrowser requests."
            );
        }

        gdFailureCache.set(
            `gdb:${endpoint}`,
            Date.now()
        );

        return null;
    }
}

// ============================================================
// ALTERNATIVE GD API
// ============================================================
//
// The alternate API is intentionally isolated here.
// If it is unavailable, the bot simply falls back to GDBrowser.
// ============================================================

async function alternateGDRequest(url) {
    const key = `alt:${url}`;

    const cached = gdCache.get(key);

    if (
        cached &&
        Date.now() - cached.time < GD_CACHE_TIME
    ) {
        return cached.data;
    }

    const failure = gdFailureCache.get(key);

    if (
        failure &&
        Date.now() - failure < GD_FAILURE_CACHE_TIME
    ) {
        return null;
    }

    try {
        const result = await fetchJSON(url);

        if (result !== null) {
            gdCache.set(key, {
                data: result,
                time: Date.now()
            });

            return result;
        }

        return null;
    } catch (error) {
        gdFailureCache.set(key, Date.now());

        console.warn(
            `Alternative GD API failed: ${url} (${error.message})`
        );

        return null;
    }
}

// ============================================================
// GD LEVEL
// ============================================================

async function getGDLevel(id) {
    const gdb = await gdbrowserFetch(
        `/level/${encodeURIComponent(id)}`
    );

    if (gdb) return gdb;

    // Alternate API fallback.
    const alternateUrls = [
        `${GD_ALT_API}/level/${encodeURIComponent(id)}`,
        `${GD_ALT_API}/levels/${encodeURIComponent(id)}`
    ];

    for (const url of alternateUrls) {
        const result = await alternateGDRequest(url);

        if (result) {
            return result;
        }
    }

    return null;
}

// ============================================================
// GD SEARCH
// ============================================================

async function searchGDLevels(query, options = {}) {
    const count = options.count || 10;
    const difficulty = options.difficulty;

    let endpoint =
        `/search/${encodeURIComponent(query || "*")}?count=${count}`;

    if (difficulty !== undefined) {
        endpoint += `&diff=${encodeURIComponent(difficulty)}`;
    }

    const gdb = await gdbrowserFetch(endpoint);

    if (Array.isArray(gdb)) {
        return gdb;
    }

    if (gdb && Array.isArray(gdb.levels)) {
        return gdb.levels;
    }

    // Alternate API attempts.
    const queryString =
        `?query=${encodeURIComponent(query || "")}&limit=${count}`;

    const alternateUrls = [
        `${GD_ALT_API}/search${queryString}`,
        `${GD_ALT_API}/levels/search${queryString}`
    ];

    for (const url of alternateUrls) {
        const result = await alternateGDRequest(url);

        if (Array.isArray(result)) {
            return result;
        }

        if (result && Array.isArray(result.levels)) {
            return result.levels;
        }

        if (result && Array.isArray(result.data)) {
            return result.data;
        }
    }

    return [];
}

// ============================================================
// GD PROFILE
// ============================================================

async function getGDProfile(username) {
    const endpoint =
        `/profile/${encodeURIComponent(username)}`;

    const gdb = await gdbrowserFetch(endpoint);

    if (gdb) {
        return gdb;
    }

    const alternateUrls = [
        `${GD_ALT_API}/profile/${encodeURIComponent(username)}`,
        `${GD_ALT_API}/user/${encodeURIComponent(username)}`,
        `${GD_ALT_API}/users/${encodeURIComponent(username)}`
    ];

    for (const url of alternateUrls) {
        const result = await alternateGDRequest(url);

        if (result) {
            return result;
        }
    }

    return null;
}

// ============================================================
// GD DAILY / WEEKLY
// ============================================================

async function getSpecialGDLevel(type) {
    const endpoint =
        type === "daily"
            ? "/level/daily"
            : "/level/weekly";

    const gdb = await gdbrowserFetch(endpoint);

    if (gdb) {
        return gdb;
    }

    const alternateUrls = [
        `${GD_ALT_API}/${type}`,
        `${GD_ALT_API}/level/${type}`,
        `${GD_ALT_API}/levels/${type}`
    ];

    for (const url of alternateUrls) {
        const result = await alternateGDRequest(url);

        if (result) {
            return result;
        }
    }

    return null;
}

// ============================================================
// GD SEARCH HELPERS
// ============================================================

async function getGDCategory(category) {
    let endpoint;

    switch (category) {
        case "featured":
            endpoint = "/search/featured?count=20";
            break;

        case "trending":
            endpoint = "/search/trending?count=20";
            break;

        case "recent":
            endpoint = "/search/recent?count=20";
            break;

        case "demon":
            endpoint = "/search/*?count=20&diff=-2";
            break;

        default:
            endpoint = "/search/*?count=20";
            break;
    }

    const result = await gdbrowserFetch(endpoint);

    if (Array.isArray(result)) {
        return result;
    }

    if (result && Array.isArray(result.levels)) {
        return result.levels;
    }

    return [];
}

// ============================================================
// EMBEDS
// ============================================================

function createLevelEmbed(level, titlePrefix = "") {
    const id = level.id || level.levelID || level.ID || "Unknown";
    const name = level.name || "Unknown Level";
    const author =
        level.author ||
        level.creator ||
        level.creatorName ||
        "Unknown";

    const difficulty = difficultyName(level);

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(
            `${titlePrefix ? titlePrefix + " " : ""}${name}`
        )
        .setURL(levelUrl(id))
        .setDescription(
            `${difficultyEmoji(difficulty)} **${difficulty}**`
        )
        .addFields(
            {
                name: "Level ID",
                value: `\`${id}\``,
                inline: true
            },
            {
                name: "Creator",
                value: truncate(author, 100),
                inline: true
            },
            {
                name: "Stars",
                value: String(level.stars ?? 0),
                inline: true
            },
            {
                name: "Downloads",
                value: String(level.downloads ?? 0),
                inline: true
            },
            {
                name: "Likes",
                value: String(level.likes ?? 0),
                inline: true
            },
            {
                name: "Length",
                value: String(level.length || "Unknown"),
                inline: true
            }
        );

    if (level.coins !== undefined) {
        embed.addFields({
            name: "Coins",
            value: String(level.coins),
            inline: true
        });
    }

    if (level.objects !== undefined) {
        embed.addFields({
            name: "Objects",
            value: String(level.objects),
            inline: true
        });
    }

    if (level.songName) {
        embed.addFields({
            name: "Song",
            value: truncate(
                `${level.songName}${level.songAuthor ? ` — ${level.songAuthor}` : ""}`,
                100
            ),
            inline: false
        });
    }

    if (level.description) {
        embed.addFields({
            name: "Description",
            value: truncate(level.description, 900),
            inline: false
        });
    }

    embed.setFooter({
        text: `MotionBOT • Geometry Dash • ${id}`
    });

    return embed;
}

function gdUnavailableEmbed() {
    return new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("Geometry Dash service unavailable")
        .setDescription(
            "The Geometry Dash data service rejected or failed the request.\n\n" +
            "This is usually temporary. No API key is required."
        )
        .setFooter({
            text: "MotionBOT"
        });
}

// ============================================================
// COMMANDS
// ============================================================

const commands = [

    new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show all MotionBOT commands"),

    new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Check bot latency"),

    new SlashCommandBuilder()
        .setName("botinfo")
        .setDescription("Show MotionBOT information"),

    new SlashCommandBuilder()
        .setName("uptime")
        .setDescription("Show bot uptime"),

    new SlashCommandBuilder()
        .setName("serverinfo")
        .setDescription("Show server information"),

    new SlashCommandBuilder()
        .setName("userinfo")
        .setDescription("Show user information")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("User to inspect")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("avatar")
        .setDescription("Show a user's avatar")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("User")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("membercount")
        .setDescription("Show server member count"),

    new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Delete messages")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageMessages.toString()
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription("Number of messages")
                .setMinValue(1)
                .setMaxValue(100)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("kick")
        .setDescription("Kick a member")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.KickMembers.toString()
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a member")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.BanMembers.toString()
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("unban")
        .setDescription("Unban a user")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.BanMembers.toString()
        )
        .addStringOption(option =>
            option
                .setName("userid")
                .setDescription("User ID")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("timeout")
        .setDescription("Timeout a member")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ModerateMembers.toString()
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member")
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("minutes")
                .setDescription("Timeout duration")
                .setMinValue(1)
                .setMaxValue(40320)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("untimeout")
        .setDescription("Remove a timeout")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ModerateMembers.toString()
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("warn")
        .setDescription("Warn a member")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ModerateMembers.toString()
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("warnings")
        .setDescription("Show warnings")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("slowmode")
        .setDescription("Set channel slowmode")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageChannels.toString()
        )
        .addIntegerOption(option =>
            option
                .setName("seconds")
                .setDescription("Seconds")
                .setMinValue(0)
                .setMaxValue(21600)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("lock")
        .setDescription("Lock the current channel")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageChannels.toString()
        ),

    new SlashCommandBuilder()
        .setName("unlock")
        .setDescription("Unlock the current channel")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageChannels.toString()
        ),

    new SlashCommandBuilder()
        .setName("poll")
        .setDescription("Create a yes/no poll")
        .addStringOption(option =>
            option
                .setName("question")
                .setDescription("Poll question")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("roll")
        .setDescription("Roll a dice")
        .addIntegerOption(option =>
            option
                .setName("sides")
                .setDescription("Number of sides")
                .setMinValue(2)
                .setMaxValue(1000)
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("coinflip")
        .setDescription("Flip a coin"),

    new SlashCommandBuilder()
        .setName("8ball")
        .setDescription("Ask the magic 8-ball")
        .addStringOption(option =>
            option
                .setName("question")
                .setDescription("Question")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("choose")
        .setDescription("Choose between options")
        .addStringOption(option =>
            option
                .setName("options")
                .setDescription("Separate options with commas")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("rate")
        .setDescription("Rate something")
        .addStringOption(option =>
            option
                .setName("thing")
                .setDescription("Thing to rate")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("ship")
        .setDescription("Ship two users")
        .addUserOption(option =>
            option
                .setName("user1")
                .setDescription("First user")
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName("user2")
                .setDescription("Second user")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("announce")
        .setDescription("Send an announcement")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageMessages.toString()
        )
        .addStringOption(option =>
            option
                .setName("message")
                .setDescription("Announcement")
                .setRequired(true)
        ),

    // ========================================================
    // GD
    // ========================================================

    new SlashCommandBuilder()
        .setName("gd")
        .setDescription("Geometry Dash tools")

        .addSubcommand(sub =>
            sub
                .setName("level")
                .setDescription("Get a Geometry Dash level")
                .addStringOption(option =>
                    option
                        .setName("id")
                        .setDescription("Level ID")
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("search")
                .setDescription("Search Geometry Dash levels")
                .addStringOption(option =>
                    option
                        .setName("query")
                        .setDescription("Level name")
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("random")
                .setDescription("Find a random level")
        )

        .addSubcommand(sub =>
            sub
                .setName("daily")
                .setDescription("Show the current daily level")
        )

        .addSubcommand(sub =>
            sub
                .setName("weekly")
                .setDescription("Show the current weekly demon")
        )

        .addSubcommand(sub =>
            sub
                .setName("featured")
                .setDescription("Show featured levels")
        )

        .addSubcommand(sub =>
            sub
                .setName("trending")
                .setDescription("Show trending levels")
        )

        .addSubcommand(sub =>
            sub
                .setName("recent")
                .setDescription("Show recent levels")
        )

        .addSubcommand(sub =>
            sub
                .setName("demon")
                .setDescription("Find demon levels")
        )

        .addSubcommand(sub =>
            sub
                .setName("profile")
                .setDescription("Look up a Geometry Dash profile")
                .addStringOption(option =>
                    option
                        .setName("username")
                        .setDescription("Username")
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("challenge")
                .setDescription("Show the server GD challenge")
        )

        .addSubcommand(sub =>
            sub
                .setName("setchallenge")
                .setDescription("Set the server GD challenge")
                .setDefaultMemberPermissions(
                    PermissionFlagsBits.ManageGuild.toString()
                )
                .addStringOption(option =>
                    option
                        .setName("level")
                        .setDescription("Level ID or name")
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("event")
                .setDescription("Show the current GD event")
        )

        .addSubcommand(sub =>
            sub
                .setName("setevent")
                .setDescription("Set the server GD event")
                .setDefaultMemberPermissions(
                    PermissionFlagsBits.ManageGuild.toString()
                )
                .addStringOption(option =>
                    option
                        .setName("event")
                        .setDescription("Event name")
                        .setRequired(true)
                )
        )
];

// ============================================================
// REGISTER COMMANDS
// ============================================================

async function registerCommands() {
    const rest = new REST({
        version: "10"
    }).setToken(TOKEN);

    try {
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            {
                body: commands.map(command =>
                    command.toJSON()
                )
            }
        );

        console.log(
            `Registered ${commands.length} global slash commands.`
        );
    } catch (error) {
        console.error(
            "Failed to register commands:",
            error.message
        );
    }
}

// ============================================================
// READY
// ============================================================

client.once("clientReady", async () => {
    console.log(
        `Logged in as ${client.user.tag}`
    );

    console.log(
        `Serving ${client.guilds.cache.size} server(s).`
    );

    await registerCommands();
});

// ============================================================
// COMMAND HANDLER
// ============================================================

client.on("interactionCreate", async interaction => {
    try {

        // ====================================================
        // BUTTONS
        // ====================================================

        if (interaction.isButton()) {

            if (
                interaction.customId === "poll_yes" ||
                interaction.customId === "poll_no"
            ) {
                await interaction.reply({
                    content:
                        interaction.customId === "poll_yes"
                            ? "You voted **Yes**."
                            : "You voted **No**.",
                    ephemeral: true
                });

                return;
            }

            return;
        }

        if (!interaction.isChatInputCommand()) {
            return;
        }

        // ====================================================
        // BASIC
        // ====================================================

        if (interaction.commandName === "help") {

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle("MotionBOT")
                .setDescription(
                    "A compact multipurpose Discord bot with Geometry Dash tools."
                )
                .addFields(
                    {
                        name: "Information",
                        value:
                            "`/ping`\n" +
                            "`/botinfo`\n" +
                            "`/uptime`\n" +
                            "`/serverinfo`\n" +
                            "`/userinfo`\n" +
                            "`/avatar`\n" +
                            "`/membercount`"
                    },
                    {
                        name: "Moderation",
                        value:
                            "`/clear`\n" +
                            "`/kick`\n" +
                            "`/ban`\n" +
                            "`/unban`\n" +
                            "`/timeout`\n" +
                            "`/untimeout`\n" +
                            "`/warn`\n" +
                            "`/warnings`\n" +
                            "`/slowmode`\n" +
                            "`/lock`\n" +
                            "`/unlock`"
                    },
                    {
                        name: "Fun",
                        value:
                            "`/poll`\n" +
                            "`/roll`\n" +
                            "`/coinflip`\n" +
                            "`/8ball`\n" +
                            "`/choose`\n" +
                            "`/rate`\n" +
                            "`/ship`"
                    },
                    {
                        name: "Geometry Dash",
                        value:
                            "`/gd level`\n" +
                            "`/gd search`\n" +
                            "`/gd random`\n" +
                            "`/gd daily`\n" +
                            "`/gd weekly`\n" +
                            "`/gd featured`\n" +
                            "`/gd trending`\n" +
                            "`/gd recent`\n" +
                            "`/gd demon`\n" +
                            "`/gd profile`\n" +
                            "`/gd challenge`\n" +
                            "`/gd event`"
                    }
                )
                .setFooter({
                    text: "MotionBOT"
                });

            await interaction.reply({
                embeds: [embed]
            });

            return;
        }

        if (interaction.commandName === "ping") {

            const sent = await interaction.reply({
                content: "Calculating...",
                fetchReply: true
            });

            const latency =
                sent.createdTimestamp -
                interaction.createdTimestamp;

            await interaction.editReply(
                `🏓 **Pong!** ${latency}ms\n` +
                `WebSocket: ${client.ws.ping}ms`
            );

            return;
        }

        if (interaction.commandName === "botinfo") {

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle("MotionBOT")
                .addFields(
                    {
                        name: "Servers",
                        value: String(
                            client.guilds.cache.size
                        ),
                        inline: true
                    },
                    {
                        name: "Users",
                        value: String(
                            client.guilds.cache.reduce(
                                (total, guild) =>
                                    total + (guild.memberCount || 0),
                                0
                            )
                        ),
                        inline: true
                    },
                    {
                        name: "Uptime",
                        value: formatDuration(
                            process.uptime()
                        ),
                        inline: true
                    },
                    {
                        name: "Node.js",
                        value: process.version,
                        inline: true
                    },
                    {
                        name: "discord.js",
                        value: "v14",
                        inline: true
                    }
                );

            await interaction.reply({
                embeds: [embed]
            });

            return;
        }

        if (interaction.commandName === "uptime") {

            await interaction.reply(
                `⏱️ Uptime: **${formatDuration(process.uptime())}**`
            );

            return;
        }

        if (interaction.commandName === "serverinfo") {

            const guild = interaction.guild;

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(guild.name)
                .addFields(
                    {
                        name: "Owner",
                        value: `<@${guild.ownerId}>`,
                        inline: true
                    },
                    {
                        name: "Members",
                        value: String(guild.memberCount),
                        inline: true
                    },
                    {
                        name: "Channels",
                        value: String(
                            guild.channels.cache.size
                        ),
                        inline: true
                    },
                    {
                        name: "Created",
                        value:
                            `<t:${Math.floor(
                                guild.createdTimestamp / 1000
                            )}:F>`,
                        inline: false
                    }
                );

            if (guild.iconURL()) {
                embed.setThumbnail(
                    guild.iconURL({
                        size: 256
                    })
                );
            }

            await interaction.reply({
                embeds: [embed]
            });

            return;
        }

        if (interaction.commandName === "userinfo") {

            const user =
                interaction.options.getUser("user") ||
                interaction.user;

            const member =
                interaction.guild.members.cache.get(
                    user.id
                );

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(safeUserName(user))
                .setThumbnail(
                    user.displayAvatarURL({
                        size: 512
                    })
                )
                .addFields(
                    {
                        name: "Username",
                        value: `\`${user.tag}\``,
                        inline: true
                    },
                    {
                        name: "User ID",
                        value: `\`${user.id}\``,
                        inline: true
                    },
                    {
                        name: "Bot",
                        value: user.bot ? "Yes" : "No",
                        inline: true
                    }
                );

            if (member) {
                embed.addFields({
                    name: "Joined Server",
                    value:
                        member.joinedTimestamp
                            ? `<t:${Math.floor(
                                member.joinedTimestamp / 1000
                            )}:F>`
                            : "Unknown",
                    inline: false
                });
            }

            await interaction.reply({
                embeds: [embed]
            });

            return;
        }

        if (interaction.commandName === "avatar") {

            const user =
                interaction.options.getUser("user") ||
                interaction.user;

            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle(`${safeUserName(user)}'s Avatar`)
                        .setImage(
                            user.displayAvatarURL({
                                size: 1024
                            })
                        )
                ]
            });

            return;
        }

        if (interaction.commandName === "membercount") {

            await interaction.reply(
                `👥 This server has **${interaction.guild.memberCount}** members.`
            );

            return;
        }

        // ====================================================
        // MODERATION
        // ====================================================

        if (interaction.commandName === "clear") {

            const amount =
                interaction.options.getInteger("amount");

            const messages =
                await interaction.channel.bulkDelete(
                    amount,
                    true
                );

            await interaction.reply({
                content:
                    `🧹 Deleted **${messages.size}** messages.`,
                ephemeral: true
            });

            return;
        }

        if (interaction.commandName === "kick") {

            const user =
                interaction.options.getUser("user");

            const reason =
                interaction.options.getString("reason") ||
                "No reason provided.";

            const member =
                interaction.guild.members.cache.get(
                    user.id
                );

            if (!member) {
                await interaction.reply({
                    content: "That member is not in this server.",
                    ephemeral: true
                });
                return;
            }

            if (!member.kickable) {
                await interaction.reply({
                    content:
                        "I cannot kick that member. Check my role hierarchy and permissions.",
                    ephemeral: true
                });
                return;
            }

            await member.kick(reason);

            await interaction.reply(
                `👢 Kicked **${safeUserName(user)}**.\nReason: ${reason}`
            );

            return;
        }

        if (interaction.commandName === "ban") {

            const user =
                interaction.options.getUser("user");

            const reason =
                interaction.options.getString("reason") ||
                "No reason provided.";

            const member =
                interaction.guild.members.cache.get(
                    user.id
                );

            if (member && !member.bannable) {
                await interaction.reply({
                    content:
                        "I cannot ban that member. Check my role hierarchy and permissions.",
                    ephemeral: true
                });
                return;
            }

            await interaction.guild.members.ban(
                user.id,
                {
                    reason
                }
            );

            await interaction.reply(
                `🔨 Banned **${safeUserName(user)}**.\nReason: ${reason}`
            );

            return;
        }

        if (interaction.commandName === "unban") {

            const userId =
                interaction.options.getString("userid");

            await interaction.guild.members.unban(
                userId
            );

            await interaction.reply(
                `Unbanned **${userId}**.`
            );

            return;
        }

        if (interaction.commandName === "timeout") {

            const user =
                interaction.options.getUser("user");

            const minutes =
                interaction.options.getInteger("minutes");

            const member =
                interaction.guild.members.cache.get(
                    user.id
                );

            if (!member) {
                await interaction.reply({
                    content: "Member not found.",
                    ephemeral: true
                });
                return;
            }

            await member.timeout(
                minutes * 60 * 1000,
                `Timeout by ${interaction.user.tag}`
            );

            await interaction.reply(
                `⏳ Timed out **${safeUserName(user)}** for **${minutes} minutes**.`
            );

            return;
        }

        if (interaction.commandName === "untimeout") {

            const user =
                interaction.options.getUser("user");

            const member =
                interaction.guild.members.cache.get(
                    user.id
                );

            if (!member) {
                await interaction.reply({
                    content: "Member not found.",
                    ephemeral: true
                });
                return;
            }

            await member.timeout(null);

            await interaction.reply(
                `Removed timeout from **${safeUserName(user)}**.`
            );

            return;
        }

        if (interaction.commandName === "warn") {

            const user =
                interaction.options.getUser("user");

            const reason =
                interaction.options.getString("reason");

            const warnings =
                getWarnings(
                    interaction.guild.id,
                    user.id
                );

            warnings.push({
                reason,
                moderator: interaction.user.id,
                timestamp: Date.now()
            });

            saveData();

            await interaction.reply(
                `⚠️ Warned **${safeUserName(user)}**.\nReason: ${reason}\nWarnings: **${warnings.length}**`
            );

            return;
        }

        if (interaction.commandName === "warnings") {

            const user =
                interaction.options.getUser("user");

            const warnings =
                getWarnings(
                    interaction.guild.id,
                    user.id
                );

            if (!warnings.length) {
                await interaction.reply(
                    `**${safeUserName(user)}** has no warnings.`
                );
                return;
            }

            const description =
                warnings
                    .slice(-10)
                    .map(
                        (warning, index) =>
                            `**${index + 1}.** ${truncate(
                                warning.reason,
                                150
                            )}\n` +
                            `Moderator: <@${warning.moderator}>`
                    )
                    .join("\n\n");

            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xFEE75C)
                        .setTitle(
                            `Warnings — ${safeUserName(user)}`
                        )
                        .setDescription(description)
                        .setFooter({
                            text: `${warnings.length} total warning(s)`
                        })
                ]
            });

            return;
        }

        if (interaction.commandName === "slowmode") {

            const seconds =
                interaction.options.getInteger("seconds");

            await interaction.channel.setRateLimitPerUser(
                seconds
            );

            await interaction.reply(
                `🐌 Slowmode set to **${seconds} seconds**.`
            );

            return;
        }

        if (
            interaction.commandName === "lock" ||
            interaction.commandName === "unlock"
        ) {

            const locked =
                interaction.commandName === "lock";

            await interaction.channel.permissionOverwrites.edit(
                interaction.guild.roles.everyone,
                {
                    SendMessages: !locked
                }
            );

            await interaction.reply(
                locked
                    ? "🔒 Channel locked."
                    : "🔓 Channel unlocked."
            );

            return;
        }

        // ====================================================
        // FUN
        // ====================================================

        if (interaction.commandName === "poll") {

            const question =
                interaction.options.getString("question");

            const row =
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId("poll_yes")
                        .setLabel("Yes")
                        .setStyle(ButtonStyle.Success),

                    new ButtonBuilder()
                        .setCustomId("poll_no")
                        .setLabel("No")
                        .setStyle(ButtonStyle.Danger)
                );

            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle("Poll")
                        .setDescription(
                            `**${question}**`
                        )
                        .setFooter({
                            text:
                                `Poll created by ${safeUserName(interaction.user)}`
                        })
                ],
                components: [row]
            });

            return;
        }

        if (interaction.commandName === "roll") {

            const sides =
                interaction.options.getInteger("sides") || 6;

            const result =
                Math.floor(
                    Math.random() * sides
                ) + 1;

            await interaction.reply(
                `🎲 You rolled **${result}** on a d${sides}.`
            );

            return;
        }

        if (interaction.commandName === "coinflip") {

            await interaction.reply(
                Math.random() < 0.5
                    ? "🪙 **Heads**"
                    : "🪙 **Tails**"
            );

            return;
        }

        if (interaction.commandName === "8ball") {

            const answers = [
                "Yes.",
                "No.",
                "Definitely.",
                "Probably.",
                "Probably not.",
                "Ask again later.",
                "Without a doubt.",
                "I don't think so.",
                "Absolutely not.",
                "The signs point to yes."
            ];

            await interaction.reply(
                `🎱 ${randomItem(answers)}`
            );

            return;
        }

        if (interaction.commandName === "choose") {

            const options =
                interaction.options
                    .getString("options")
                    .split(",")
                    .map(x => x.trim())
                    .filter(Boolean);

            if (!options.length) {
                await interaction.reply({
                    content: "Give me at least one option.",
                    ephemeral: true
                });
                return;
            }

            await interaction.reply(
                `🎯 I choose **${randomItem(options)}**.`
            );

            return;
        }

        if (interaction.commandName === "rate") {

            const thing =
                interaction.options.getString("thing");

            const rating =
                Math.floor(
                    Math.random() * 101
                );

            await interaction.reply(
                `⭐ I rate **${thing}** **${rating}/100**.`
            );

            return;
        }

        if (interaction.commandName === "ship") {

            const user1 =
                interaction.options.getUser("user1");

            const user2 =
                interaction.options.getUser("user2");

            const score =
                Math.floor(
                    Math.random() * 101
                );

            await interaction.reply(
                `❤️ **${safeUserName(user1)} + ${safeUserName(user2)}** = **${score}%**`
            );

            return;
        }

        if (interaction.commandName === "announce") {

            const message =
                interaction.options.getString("message");

            await interaction.channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle("Announcement")
                        .setDescription(message)
                        .setFooter({
                            text:
                                `Posted by ${safeUserName(interaction.user)}`
                        })
                ]
            });

            await interaction.reply({
                content: "Announcement sent.",
                ephemeral: true
            });

            return;
        }

        // ====================================================
        // GEOMETRY DASH
        // ====================================================

        if (interaction.commandName === "gd") {

            const subcommand =
                interaction.options.getSubcommand();

            // ------------------------------------------------
            // LEVEL
            // ------------------------------------------------

            if (subcommand === "level") {

                const id =
                    interaction.options.getString("id");

                await interaction.deferReply();

                const level =
                    await getGDLevel(id);

                if (!level) {
                    await interaction.editReply({
                        embeds: [
                            gdUnavailableEmbed()
                        ]
                    });
                    return;
                }

                await interaction.editReply({
                    embeds: [
                        createLevelEmbed(level)
                    ]
                });

                return;
            }

            // ------------------------------------------------
            // SEARCH
            // ------------------------------------------------

            if (subcommand === "search") {

                const query =
                    interaction.options.getString("query");

                await interaction.deferReply();

                const levels =
                    await searchGDLevels(
                        query,
                        {
                            count: 10
                        }
                    );

                if (!levels.length) {
                    await interaction.editReply({
                        embeds: [
                            gdUnavailableEmbed()
                        ]
                    });
                    return;
                }

                const lines =
                    levels
                        .slice(0, 10)
                        .map((level, index) => {

                            const id =
                                level.id ||
                                level.levelID ||
                                level.ID ||
                                "?";

                            const name =
                                level.name ||
                                "Unknown";

                            const difficulty =
                                difficultyName(level);

                            return (
                                `**${index + 1}.** ` +
                                `${difficultyEmoji(difficulty)} ` +
                                `[${truncate(name, 50)}](${levelUrl(id)}) ` +
                                `\`${id}\``
                            );
                        })
                        .join("\n");

                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x5865F2)
                            .setTitle(
                                `Geometry Dash Search — ${query}`
                            )
                            .setDescription(lines)
                            .setFooter({
                                text: `${levels.length} result(s)`
                            })
                    ]
                });

                return;
            }

            // ------------------------------------------------
            // RANDOM
            // ------------------------------------------------

            if (subcommand === "random") {

                await interaction.deferReply();

                const levels =
                    await searchGDLevels("*", {
                        count: 50
                    });

                if (!levels.length) {
                    await interaction.editReply({
                        embeds: [
                            gdUnavailableEmbed()
                        ]
                    });
                    return;
                }

                const level =
                    randomItem(levels);

                await interaction.editReply({
                    embeds: [
                        createLevelEmbed(
                            level,
                            "🎲 Random Level:"
                        )
                    ]
                });

                return;
            }

            // ------------------------------------------------
            // DAILY
            // ------------------------------------------------

            if (subcommand === "daily") {

                await interaction.deferReply();

                const level =
                    await getSpecialGDLevel("daily");

                if (!level) {
                    await interaction.editReply({
                        embeds: [
                            gdUnavailableEmbed()
                        ]
                    });
                    return;
                }

                await interaction.editReply({
                    embeds: [
                        createLevelEmbed(
                            level,
                            "☀️ Daily:"
                        )
                    ]
                });

                return;
            }

            // ------------------------------------------------
            // WEEKLY
            // ------------------------------------------------

            if (subcommand === "weekly") {

                await interaction.deferReply();

                const level =
                    await getSpecialGDLevel("weekly");

                if (!level) {
                    await interaction.editReply({
                        embeds: [
                            gdUnavailableEmbed()
                        ]
                    });
                    return;
                }

                await interaction.editReply({
                    embeds: [
                        createLevelEmbed(
                            level,
                            "🏆 Weekly:"
                        )
                    ]
                });

                return;
            }

            // ------------------------------------------------
            // FEATURED / TRENDING / RECENT / DEMON
            // ------------------------------------------------

            if (
                subcommand === "featured" ||
                subcommand === "trending" ||
                subcommand === "recent" ||
                subcommand === "demon"
            ) {

                await interaction.deferReply();

                const levels =
                    await getGDCategory(
                        subcommand
                    );

                if (!levels.length) {
                    await interaction.editReply({
                        embeds: [
                            gdUnavailableEmbed()
                        ]
                    });
                    return;
                }

                const titleMap = {
                    featured: "⭐ Featured Levels",
                    trending: "🔥 Trending Levels",
                    recent: "🆕 Recent Levels",
                    demon: "😈 Demon Levels"
                };

                const lines =
                    levels
                        .slice(0, 15)
                        .map((level, index) => {

                            const id =
                                level.id ||
                                level.levelID ||
                                level.ID ||
                                "?";

                            const name =
                                level.name ||
                                "Unknown";

                            const difficulty =
                                difficultyName(level);

                            return (
                                `**${index + 1}.** ` +
                                `${difficultyEmoji(difficulty)} ` +
                                `[${truncate(name, 45)}](${levelUrl(id)}) ` +
                                `\`${id}\``
                            );
                        })
                        .join("\n");

                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x5865F2)
                            .setTitle(
                                titleMap[subcommand]
                            )
                            .setDescription(lines)
                    ]
                });

                return;
            }

            // ------------------------------------------------
            // PROFILE
            // ------------------------------------------------

            if (subcommand === "profile") {

                const username =
                    interaction.options.getString(
                        "username"
                    );

                await interaction.deferReply();

                const profile =
                    await getGDProfile(username);

                if (!profile) {
                    await interaction.editReply({
                        embeds: [
                            gdUnavailableEmbed()
                        ]
                    });
                    return;
                }

                const name =
                    profile.username ||
                    profile.name ||
                    username;

                const embed =
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle(
                            `Geometry Dash Profile — ${name}`
                        )
                        .addFields(
                            {
                                name: "Stars",
                                value: String(
                                    profile.stars ??
                                    profile.starCount ??
                                    0
                                ),
                                inline: true
                            },
                            {
                                name: "Demons",
                                value: String(
                                    profile.demons ??
                                    profile.demonCount ??
                                    0
                                ),
                                inline: true
                            },
                            {
                                name: "Creator Points",
                                value: String(
                                    profile.cp ??
                                    profile.creatorPoints ??
                                    0
                                ),
                                inline: true
                            },
                            {
                                name: "Diamonds",
                                value: String(
                                    profile.diamonds ??
                                    0
                                ),
                                inline: true
                            },
                            {
                                name: "Coins",
                                value: String(
                                    profile.coins ??
                                    0
                                ),
                                inline: true
                            },
                            {
                                name: "User ID",
                                value: String(
                                    profile.playerID ??
                                    profile.userID ??
                                    profile.id ??
                                    "Unknown"
                                ),
                                inline: true
                            }
                        )
                        .setFooter({
                            text: "MotionBOT • Geometry Dash"
                        });

                await interaction.editReply({
                    embeds: [embed]
                });

                return;
            }

            // ------------------------------------------------
            // SERVER CHALLENGE
            // ------------------------------------------------

            if (subcommand === "challenge") {

                const guildId =
                    interaction.guild.id;

                const challenge =
                    data.challenges[guildId];

                if (!challenge) {
                    await interaction.reply(
                        "No Geometry Dash challenge has been set."
                    );
                    return;
                }

                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x5865F2)
                            .setTitle(
                                "🎯 Server GD Challenge"
                            )
                            .setDescription(
                                challenge
                            )
                    ]
                });

                return;
            }

            // ------------------------------------------------
            // SET CHALLENGE
            // ------------------------------------------------

            if (subcommand === "setchallenge") {

                const value =
                    interaction.options.getString(
                        "level"
                    );

                data.challenges[
                    interaction.guild.id
                ] = value;

                saveData();

                await interaction.reply(
                    `🎯 Server GD challenge set to **${value}**.`
                );

                return;
            }

            // ------------------------------------------------
            // EVENT
            // ------------------------------------------------

            if (subcommand === "event") {

                const event =
                    data.events[
                        interaction.guild.id
                    ];

                if (!event) {
                    await interaction.reply(
                        "No Geometry Dash event is currently set."
                    );
                    return;
                }

                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x5865F2)
                            .setTitle(
                                "🎪 Geometry Dash Event"
                            )
                            .setDescription(event)
                    ]
                });

                return;
            }

            // ------------------------------------------------
            // SET EVENT
            // ------------------------------------------------

            if (subcommand === "setevent") {

                const value =
                    interaction.options.getString(
                        "event"
                    );

                data.events[
                    interaction.guild.id
                ] = value;

                saveData();

                await interaction.reply(
                    `🎪 Geometry Dash event set to **${value}**.`
                );

                return;
            }
        }

    } catch (error) {

        console.error(
            "Interaction error:",
            error
        );

        try {

            if (interaction.replied || interaction.deferred) {

                await interaction.editReply({
                    content:
                        "Something went wrong while processing that command."
                });

            } else {

                await interaction.reply({
                    content:
                        "Something went wrong while processing that command.",
                    ephemeral: true
                });
            }

        } catch {
            // Ignore secondary Discord errors.
        }
    }
});

// ============================================================
// ERROR HANDLING
// ============================================================

process.on("unhandledRejection", error => {
    console.error(
        "Unhandled promise rejection:",
        error
    );
});

process.on("uncaughtException", error => {
    console.error(
        "Uncaught exception:",
        error
    );
});

// ============================================================
// START
// ============================================================

client.login(TOKEN);
