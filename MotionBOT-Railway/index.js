require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN) throw new Error("DISCORD_TOKEN is missing.");
if (!CLIENT_ID) throw new Error("CLIENT_ID is missing.");

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const DATA_FILE = path.join(__dirname, "motionbot-data.json");

let data = {
    servers: {},
    warnings: {},
    challenges: {}
};

try {
    if (fs.existsSync(DATA_FILE)) {
        const saved = JSON.parse(
            fs.readFileSync(DATA_FILE, "utf8")
        );

        data = {
            ...data,
            ...saved
        };
    }
} catch (error) {
    console.error("Database load error:", error.message);
}

let saveTimer = null;

function saveData() {
    clearTimeout(saveTimer);

    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(data, null, 2)
            );
        } catch (error) {
            console.error(
                "Database save error:",
                error.message
            );
        }
    }, 1000);
}

function getServer(id) {
    if (!data.servers[id]) {
        data.servers[id] = {
            eventLevel: null
        };

        saveData();
    }

    return data.servers[id];
}

/* =========================
   GD API CACHE
========================= */

const GD_API = "https://gdbrowser.com/api";

const gdCache = new Map();

const GD_CACHE_TIME = 30000;
const GD_TIMEOUT = 8000;

async function gdFetch(endpoint) {
    const cached = gdCache.get(endpoint);

    if (
        cached &&
        Date.now() - cached.time < GD_CACHE_TIME
    ) {
        return cached.data;
    }

    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        GD_TIMEOUT
    );

    try {
        const response = await fetch(
            `${GD_API}${endpoint}`,
            {
                signal: controller.signal,
                headers: {
                    "User-Agent":
                        "MotionBOT/2.0"
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const text = await response.text();

        if (!text || text.trim() === "-1") {
            return null;
        }

        let result;

        try {
            result = JSON.parse(text);
        } catch {
            return null;
        }

        gdCache.set(endpoint, {
            data: result,
            time: Date.now()
        });

        return result;

    } catch (error) {
        console.error(
            `GD API error: ${endpoint}`,
            error.message
        );

        return null;

    } finally {
        clearTimeout(timeout);
    }
}

/* =========================
   HELPERS
========================= */

function number(value) {
    return Number(value || 0).toLocaleString();
}

function gdColor(difficulty = "") {
    const d = difficulty.toLowerCase();

    if (d.includes("extreme")) return 0xE74C3C;
    if (d.includes("insane demon")) return 0x9B59B6;
    if (d.includes("hard demon")) return 0xE67E22;
    if (d.includes("medium demon")) return 0xF1C40F;
    if (d.includes("easy demon")) return 0x2ECC71;
    if (d.includes("demon")) return 0xFF5555;
    if (d.includes("insane")) return 0x8E44AD;
    if (d.includes("harder")) return 0xF39C12;
    if (d.includes("hard")) return 0xE67E22;
    if (d.includes("normal")) return 0x3498DB;
    if (d.includes("easy")) return 0x2ECC71;

    return 0x5865F2;
}

function levelEmbed(level, title) {
    if (!level) return null;

    const description =
        level.description &&
        level.description !== "(No description provided)"
            ? level.description.slice(0, 900)
            : "No description provided.";

    const embed = new EmbedBuilder()
        .setTitle(
            title || `🎮 ${level.name}`
        )
        .setURL(
            `https://gdbrowser.com/${level.id}`
        )
        .setDescription(description)
        .setColor(
            gdColor(level.difficulty)
        )
        .addFields(
            {
                name: "Difficulty",
                value:
                    level.difficulty ||
                    "Unknown",
                inline: true
            },
            {
                name: "Length",
                value:
                    level.length ||
                    "Unknown",
                inline: true
            },
            {
                name: "Stars",
                value: number(level.stars),
                inline: true
            },
            {
                name: "Downloads",
                value: number(level.downloads),
                inline: true
            },
            {
                name: "Likes",
                value: number(level.likes),
                inline: true
            },
            {
                name: "Objects",
                value: number(level.objects),
                inline: true
            },
            {
                name: "Creator",
                value:
                    level.author ||
                    "Unknown",
                inline: true
            },
            {
                name: "Song",
                value:
                    level.songName ||
                    "Unknown",
                inline: true
            },
            {
                name: "Level ID",
                value: `\`${level.id}\``,
                inline: true
            }
        )
        .setFooter({
            text:
                "Geometry Dash • MotionBOT"
        });

    if (level.featured) {
        embed.addFields({
            name: "Rating",
            value:
                level.epic
                    ? "✨ Epic"
                    : "⭐ Featured",
            inline: true
        });
    }

    return embed;
}

async function permission(
    interaction,
    flag,
    name
) {
    if (
        !interaction.member.permissions.has(flag)
    ) {
        await interaction.reply({
            content:
                `You need **${name}**.`,
            ephemeral: true
        });

        return false;
    }

    return true;
}

/* =========================
   COMMANDS
========================= */

const commands = [
    new SlashCommandBuilder()
        .setName("help")
        .setDescription(
            "Show MotionBOT commands"
        ),

    new SlashCommandBuilder()
        .setName("ping")
        .setDescription(
            "Check bot latency"
        ),

    new SlashCommandBuilder()
        .setName("botinfo")
        .setDescription(
            "Show bot information"
        ),

    new SlashCommandBuilder()
        .setName("uptime")
        .setDescription(
            "Show bot uptime"
        ),

    new SlashCommandBuilder()
        .setName("serverinfo")
        .setDescription(
            "Show server information"
        ),

    new SlashCommandBuilder()
        .setName("userinfo")
        .setDescription(
            "Show user information"
        )
        .addUserOption(o =>
            o.setName("user")
                .setDescription("User")
        ),

    new SlashCommandBuilder()
        .setName("avatar")
        .setDescription(
            "Show a user's avatar"
        )
        .addUserOption(o =>
            o.setName("user")
                .setDescription("User")
        ),

    new SlashCommandBuilder()
        .setName("membercount")
        .setDescription(
            "Show member count"
        ),

    new SlashCommandBuilder()
        .setName("clear")
        .setDescription(
            "Delete messages"
        )
        .addIntegerOption(o =>
            o.setName("amount")
                .setDescription(
                    "Number of messages"
                )
                .setMinValue(1)
                .setMaxValue(100)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("kick")
        .setDescription(
            "Kick a member"
        )
        .addUserOption(o =>
            o.setName("user")
                .setDescription("Member")
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName("reason")
                .setDescription("Reason")
        ),

    new SlashCommandBuilder()
        .setName("ban")
        .setDescription(
            "Ban a member"
        )
        .addUserOption(o =>
            o.setName("user")
                .setDescription("Member")
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName("reason")
                .setDescription("Reason")
        ),

    new SlashCommandBuilder()
        .setName("unban")
        .setDescription(
            "Unban a user"
        )
        .addStringOption(o =>
            o.setName("userid")
                .setDescription("User ID")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("timeout")
        .setDescription(
            "Timeout a member"
        )
        .addUserOption(o =>
            o.setName("user")
                .setDescription("Member")
                .setRequired(true)
        )
        .addIntegerOption(o =>
            o.setName("minutes")
                .setDescription("Minutes")
                .setMinValue(1)
                .setMaxValue(40320)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("untimeout")
        .setDescription(
            "Remove a timeout"
        )
        .addUserOption(o =>
            o.setName("user")
                .setDescription("Member")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("warn")
        .setDescription(
            "Warn a member"
        )
        .addUserOption(o =>
            o.setName("user")
                .setDescription("Member")
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName("reason")
                .setDescription("Reason")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("warnings")
        .setDescription(
            "View warnings"
        )
        .addUserOption(o =>
            o.setName("user")
                .setDescription("User")
        ),

    new SlashCommandBuilder()
        .setName("slowmode")
        .setDescription(
            "Set channel slowmode"
        )
        .addIntegerOption(o =>
            o.setName("seconds")
                .setDescription("Seconds")
                .setMinValue(0)
                .setMaxValue(21600)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("lock")
        .setDescription(
            "Lock current channel"
        ),

    new SlashCommandBuilder()
        .setName("unlock")
        .setDescription(
            "Unlock current channel"
        ),

    new SlashCommandBuilder()
        .setName("poll")
        .setDescription(
            "Create a poll"
        )
        .addStringOption(o =>
            o.setName("question")
                .setDescription("Question")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("roll")
        .setDescription(
            "Roll a number"
        )
        .addIntegerOption(o =>
            o.setName("max")
                .setDescription("Maximum")
                .setMinValue(2)
                .setMaxValue(1000000)
        ),

    new SlashCommandBuilder()
        .setName("coinflip")
        .setDescription(
            "Flip a coin"
        ),

    new SlashCommandBuilder()
        .setName("8ball")
        .setDescription(
            "Ask the magic 8-ball"
        )
        .addStringOption(o =>
            o.setName("question")
                .setDescription("Question")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("choose")
        .setDescription(
            "Choose between options"
        )
        .addStringOption(o =>
            o.setName("options")
                .setDescription(
                    "Separate choices with commas"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("rate")
        .setDescription(
            "Rate something"
        )
        .addStringOption(o =>
            o.setName("thing")
                .setDescription("Thing")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("ship")
        .setDescription(
            "Calculate compatibility"
        )
        .addUserOption(o =>
            o.setName("user1")
                .setDescription("First user")
                .setRequired(true)
        )
        .addUserOption(o =>
            o.setName("user2")
                .setDescription("Second user")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("announce")
        .setDescription(
            "Create an announcement"
        )
        .addStringOption(o =>
            o.setName("message")
                .setDescription("Message")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("gd")
        .setDescription(
            "Geometry Dash tools"
        )

        .addSubcommand(s =>
            s.setName("level")
                .setDescription(
                    "Look up a level"
                )
                .addStringOption(o =>
                    o.setName("id")
                        .setDescription(
                            "Level ID"
                        )
                        .setRequired(true)
                )
        )

        .addSubcommand(s =>
            s.setName("search")
                .setDescription(
                    "Search levels"
                )
                .addStringOption(o =>
                    o.setName("query")
                        .setDescription(
                            "Level name"
                        )
                        .setRequired(true)
                )
        )

        .addSubcommand(s =>
            s.setName("random")
                .setDescription(
                    "Generate a random level"
                )
                .addStringOption(o =>
                    o.setName("difficulty")
                        .setDescription(
                            "Difficulty"
                        )
                        .addChoices(
                            {
                                name: "Any",
                                value: "any"
                            },
                            {
                                name: "Easy",
                                value: "easy"
                            },
                            {
                                name: "Normal",
                                value: "normal"
                            },
                            {
                                name: "Hard",
                                value: "hard"
                            },
                            {
                                name: "Harder",
                                value: "harder"
                            },
                            {
                                name: "Insane",
                                value: "insane"
                            },
                            {
                                name: "Demon",
                                value: "demon"
                            }
                        )
                )
        )

        .addSubcommand(s =>
            s.setName("daily")
                .setDescription(
                    "Current Daily level"
                )
        )

        .addSubcommand(s =>
            s.setName("weekly")
                .setDescription(
                    "Current Weekly Demon"
                )
        )

        .addSubcommand(s =>
            s.setName("featured")
                .setDescription(
                    "Random Featured level"
                )
        )

        .addSubcommand(s =>
            s.setName("trending")
                .setDescription(
                    "Random Trending level"
                )
        )

        .addSubcommand(s =>
            s.setName("recent")
                .setDescription(
                    "Random Recent level"
                )
        )

        .addSubcommand(s =>
            s.setName("demon")
                .setDescription(
                    "Random Demon"
                )
        )

        .addSubcommand(s =>
            s.setName("profile")
                .setDescription(
                    "GD profile"
                )
                .addStringOption(o =>
                    o.setName("username")
                        .setDescription(
                            "Username"
                        )
                        .setRequired(true)
                )
        )

        .addSubcommand(s =>
            s.setName("challenge")
                .setDescription(
                    "Server GD challenge"
                )
        )

        .addSubcommand(s =>
            s.setName("setchallenge")
                .setDescription(
                    "Set server GD challenge"
                )
                .addStringOption(o =>
                    o.setName("id")
                        .setDescription(
                            "Level ID"
                        )
                        .setRequired(true)
                )
        )

        .addSubcommand(s =>
            s.setName("event")
                .setDescription(
                    "Server Event Level"
                )
        )

        .addSubcommand(s =>
            s.setName("setevent")
                .setDescription(
                    "Set server Event Level"
                )
                .addStringOption(o =>
                    o.setName("id")
                        .setDescription(
                            "Level ID"
                        )
                        .setRequired(true)
                )
        )
].map(c => c.toJSON());

/* =========================
   COMMAND REGISTRATION
========================= */

async function registerCommands() {
    const rest = new REST({
        version: "10"
    }).setToken(TOKEN);

    await rest.put(
        Routes.applicationCommands(
            CLIENT_ID
        ),
        {
            body: commands
        }
    );

    console.log(
        `Registered ${commands.length} global commands.`
    );
}

/* =========================
   READY
========================= */

client.once(
    "clientReady",
    readyClient => {
        console.log(
            `MotionBOT online as ${readyClient.user.tag}`
        );

        readyClient.user.setActivity(
            "/help"
        );
    }
);

/* =========================
   INTERACTIONS
========================= */

client.on(
    "interactionCreate",
    async interaction => {

        if (
            !interaction.isChatInputCommand()
        ) return;

        try {

            const name =
                interaction.commandName;

            /* GENERAL */

            if (name === "help") {
                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                "MotionBOT"
                            )
                            .setDescription(
                                "Discord utilities, moderation and Geometry Dash tools."
                            )
                            .setColor(
                                0x5865F2
                            )
                            .addFields(
                                {
                                    name:
                                        "General",
                                    value:
                                        "`/ping` `/botinfo` `/uptime`\n" +
                                        "`/serverinfo` `/userinfo` `/avatar`\n" +
                                        "`/membercount`"
                                },
                                {
                                    name:
                                        "Moderation",
                                    value:
                                        "`/clear` `/kick` `/ban` `/unban`\n" +
                                        "`/timeout` `/untimeout` `/warn`\n" +
                                        "`/warnings` `/slowmode` `/lock` `/unlock`"
                                },
                                {
                                    name:
                                        "Fun",
                                    value:
                                        "`/poll` `/roll` `/coinflip`\n" +
                                        "`/8ball` `/choose` `/rate` `/ship`"
                                },
                                {
                                    name:
                                        "Geometry Dash",
                                    value:
                                        "`/gd level` `/gd search` `/gd random`\n" +
                                        "`/gd daily` `/gd weekly` `/gd featured`\n" +
                                        "`/gd trending` `/gd recent` `/gd demon`\n" +
                                        "`/gd profile` `/gd challenge` `/gd event`"
                                }
                            )
                    ]
                });
            }

            if (name === "ping") {
                return interaction.reply(
                    `🏓 **${client.ws.ping}ms**`
                );
            }

            if (name === "botinfo") {
                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                "MotionBOT"
                            )
                            .setDescription(
                                "Lightweight Discord + Geometry Dash bot."
                            )
                            .setColor(
                                0x5865F2
                            )
                            .addFields(
                                {
                                    name:
                                        "Servers",
                                    value:
                                        `${client.guilds.cache.size}`,
                                    inline: true
                                },
                                {
                                    name:
                                        "Commands",
                                    value:
                                        `${commands.length}`,
                                    inline: true
                                },
                                {
                                    name:
                                        "Memory",
                                    value:
                                        `${Math.round(
                                            process.memoryUsage()
                                                .rss /
                                            1024 /
                                            1024
                                        )} MB`,
                                    inline: true
                                }
                            )
                    ]
                });
            }

            if (name === "uptime") {
                const seconds =
                    Math.floor(
                        process.uptime()
                    );

                const days =
                    Math.floor(
                        seconds / 86400
                    );

                const hours =
                    Math.floor(
                        (seconds % 86400) /
                        3600
                    );

                const minutes =
                    Math.floor(
                        (seconds % 3600) /
                        60
                    );

                const secs =
                    seconds % 60;

                return interaction.reply(
                    `⏱️ \`${days}d ${hours}h ${minutes}m ${secs}s\``
                );
            }

            if (name === "serverinfo") {
                const guild =
                    interaction.guild;

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                guild.name
                            )
                            .setColor(
                                0x5865F2
                            )
                            .addFields(
                                {
                                    name:
                                        "Members",
                                    value:
                                        number(
                                            guild.memberCount
                                        ),
                                    inline: true
                                },
                                {
                                    name:
                                        "Channels",
                                    value:
                                        number(
                                            guild.channels.cache.size
                                        ),
                                    inline: true
                                },
                                {
                                    name:
                                        "Roles",
                                    value:
                                        number(
                                            guild.roles.cache.size
                                        ),
                                    inline: true
                                },
                                {
                                    name:
                                        "Owner",
                                    value:
                                        `<@${guild.ownerId}>`,
                                    inline: true
                                },
                                {
                                    name:
                                        "Server ID",
                                    value:
                                        `\`${guild.id}\``,
                                    inline: true
                                }
                            )
                    ]
                });
            }

            if (
                name === "userinfo" ||
                name === "avatar"
            ) {
                const user =
                    interaction.options.getUser(
                        "user"
                    ) ||
                    interaction.user;

                if (
                    name === "avatar"
                ) {
                    const avatar =
                        user.displayAvatarURL({
                            size: 1024
                        });

                    return interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    `${user.tag}'s Avatar`
                                )
                                .setImage(
                                    avatar
                                )
                                .setColor(
                                    0x5865F2
                                )
                        ]
                    });
                }

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                user.tag
                            )
                            .setThumbnail(
                                user.displayAvatarURL({
                                    size: 512
                                })
                            )
                            .setColor(
                                0x5865F2
                            )
                            .addFields({
                                name:
                                    "User ID",
                                value:
                                    `\`${user.id}\``
                            })
                    ]
                });
            }

            if (
                name === "membercount"
            ) {
                return interaction.reply(
                    `👥 **${number(
                        interaction.guild.memberCount
                    )}** members`
                );
            }

            /* MODERATION */

            if (name === "clear") {
                if (
                    !await permission(
                        interaction,
                        PermissionsBitField
                            .Flags
                            .ManageMessages,
                        "Manage Messages"
                    )
                ) return;

                const amount =
                    interaction.options.getInteger(
                        "amount"
                    );

                const deleted =
                    await interaction.channel.bulkDelete(
                        amount,
                        true
                    );

                return interaction.reply({
                    content:
                        `Deleted **${deleted.size}** messages.`,
                    ephemeral: true
                });
            }

            if (
                name === "kick" ||
                name === "ban"
            ) {
                const isBan =
                    name === "ban";

                const allowed =
                    await permission(
                        interaction,
                        isBan
                            ? PermissionsBitField.Flags.BanMembers
                            : PermissionsBitField.Flags.KickMembers,
                        isBan
                            ? "Ban Members"
                            : "Kick Members"
                    );

                if (!allowed) return;

                const user =
                    interaction.options.getUser(
                        "user"
                    );

                const member =
                    await interaction.guild.members
                        .fetch(user.id)
                        .catch(() => null);

                if (
                    member &&
                    (
                        isBan
                            ? !member.bannable
                            : !member.kickable
                    )
                ) {
                    return interaction.reply({
                        content:
                            "I cannot moderate that member. Check role hierarchy.",
                        ephemeral: true
                    });
                }

                const reason =
                    interaction.options.getString(
                        "reason"
                    ) ||
                    "No reason provided";

                if (isBan) {
                    await interaction.guild.members.ban(
                        user.id,
                        {
                            reason
                        }
                    );
                } else {
                    await member.kick(
                        reason
                    );
                }

                return interaction.reply(
                    `${isBan ? "🔨 Banned" : "👢 Kicked"} **${user.tag}**\nReason: ${reason}`
                );
            }

            if (name === "unban") {
                if (
                    !await permission(
                        interaction,
                        PermissionsBitField
                            .Flags
                            .BanMembers,
                        "Ban Members"
                    )
                ) return;

                const id =
                    interaction.options.getString(
                        "userid"
                    );

                await interaction.guild.members.unban(
                    id
                );

                return interaction.reply(
                    `Unbanned **${id}**.`
                );
            }

            if (
                name === "timeout" ||
                name === "untimeout"
            ) {
                if (
                    !await permission(
                        interaction,
                        PermissionsBitField
                            .Flags
                            .ModerateMembers,
                        "Moderate Members"
                    )
                ) return;

                const user =
                    interaction.options.getUser(
                        "user"
                    );

                const member =
                    await interaction.guild.members
                        .fetch(user.id)
                        .catch(() => null);

                if (!member) {
                    return interaction.reply({
                        content:
                            "Member not found.",
                        ephemeral: true
                    });
                }

                if (
                    name === "untimeout"
                ) {
                    await member.timeout(
                        null
                    );

                    return interaction.reply(
                        `Removed timeout from **${user.tag}**.`
                    );
                }

                const minutes =
                    interaction.options.getInteger(
                        "minutes"
                    );

                await member.timeout(
                    minutes * 60000,
                    `Timeout by ${interaction.user.tag}`
                );

                return interaction.reply(
                    `⏱️ Timed out **${user.tag}** for **${minutes} minutes**.`
                );
            }

            if (
                name === "warn"
            ) {
                if (
                    !await permission(
                        interaction,
                        PermissionsBitField
                            .Flags
                            .ModerateMembers,
                        "Moderate Members"
                    )
                ) return;

                const user =
                    interaction.options.getUser(
                        "user"
                    );

                const reason =
                    interaction.options.getString(
                        "reason"
                    );

                const key =
                    `${interaction.guild.id}:${user.id}`;

                if (
                    !data.warnings[key]
                ) {
                    data.warnings[key] =
                        [];
                }

                data.warnings[key].push({
                    reason,
                    moderator:
                        interaction.user.id,
                    time:
                        Date.now()
                });

                saveData();

                return interaction.reply(
                    `⚠️ Warned **${user.tag}**.\nReason: ${reason}`
                );
            }

            if (
                name === "warnings"
            ) {
                const user =
                    interaction.options.getUser(
                        "user"
                    ) ||
                    interaction.user;

                const key =
                    `${interaction.guild.id}:${user.id}`;

                const warnings =
                    data.warnings[key] ||
                    [];

                if (!warnings.length) {
                    return interaction.reply(
                        `**${user.tag}** has no warnings.`
                    );
                }

                const text =
                    warnings
                        .slice(-10)
                        .map(
                            (w, i) =>
                                `**${i + 1}.** ${w.reason}\n` +
                                `Moderator: <@${w.moderator}>`
                        )
                        .join(
                            "\n\n"
                        );

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                `Warnings • ${user.tag}`
                            )
                            .setDescription(
                                text
                            )
                            .setColor(
                                0xF1C40F
                            )
                    ]
                });
            }

            if (
                name === "slowmode"
            ) {
                if (
                    !await permission(
                        interaction,
                        PermissionsBitField
                            .Flags
                            .ManageChannels,
                        "Manage Channels"
                    )
                ) return;

                const seconds =
                    interaction.options.getInteger(
                        "seconds"
                    );

                await interaction.channel.setRateLimitPerUser(
                    seconds
                );

                return interaction.reply(
                    seconds
                        ? `Slowmode: **${seconds}s**`
                        : "Slowmode disabled."
                );
            }

            if (
                name === "lock" ||
                name === "unlock"
            ) {
                if (
                    !await permission(
                        interaction,
                        PermissionsBitField
                            .Flags
                            .ManageChannels,
                        "Manage Channels"
                    )
                ) return;

                await interaction.channel.permissionOverwrites.edit(
                    interaction.guild.roles.everyone,
                    {
                        SendMessages:
                            name === "lock"
                                ? false
                                : null
                    }
                );

                return interaction.reply(
                    name === "lock"
                        ? "🔒 Channel locked."
                        : "🔓 Channel unlocked."
                );
            }

            /* FUN */

            if (
                name === "roll"
            ) {
                const max =
                    interaction.options.getInteger(
                        "max"
                    ) ||
                    100;

                return interaction.reply(
                    `🎲 **${Math.floor(
                        Math.random() * max
                    ) + 1} / ${max}**`
                );
            }

            if (
                name === "coinflip"
            ) {
                return interaction.reply(
                    Math.random() < 0.5
                        ? "🪙 **Heads!**"
                        : "🪙 **Tails!**"
                );
            }

            if (
                name === "8ball"
            ) {
                const answers = [
                    "Absolutely.",
                    "Definitely.",
                    "Most likely.",
                    "Probably.",
                    "Maybe.",
                    "Ask again later.",
                    "Probably not.",
                    "No.",
                    "Absolutely not."
                ];

                return interaction.reply(
                    `🎱 ${
                        answers[
                            Math.floor(
                                Math.random() *
                                answers.length
                            )
                        ]
                    }`
                );
            }

            if (
                name === "choose"
            ) {
                const choices =
                    interaction.options
                        .getString(
                            "options"
                        )
                        .split(",")
                        .map(
                            x => x.trim()
                        )
                        .filter(Boolean);

                if (
                    choices.length < 2
                ) {
                    return interaction.reply({
                        content:
                            "Provide at least two choices separated by commas.",
                        ephemeral: true
                    });
                }

                return interaction.reply(
                    `🎯 **${
                        choices[
                            Math.floor(
                                Math.random() *
                                choices.length
                            )
                        ]
                    }**`
                );
            }

            if (
                name === "rate"
            ) {
                const thing =
                    interaction.options.getString(
                        "thing"
                    );

                return interaction.reply(
                    `📊 **${thing}** — **${
                        Math.floor(
                            Math.random() * 101
                        )
                    }/100**`
                );
            }

            if (
                name === "ship"
            ) {
                const a =
                    interaction.options.getUser(
                        "user1"
                    );

                const b =
                    interaction.options.getUser(
                        "user2"
                    );

                const hash =
                    (
                        BigInt(a.id) +
                        BigInt(b.id)
                    ) %
                    101n;

                return interaction.reply(
                    `💞 **${a.username} × ${b.username}**\nCompatibility: **${hash}%**`
                );
            }

            if (
                name === "poll"
            ) {
                if (
                    !await permission(
                        interaction,
                        PermissionsBitField
                            .Flags
                            .ManageMessages,
                        "Manage Messages"
                    )
                ) return;

                const question =
                    interaction.options.getString(
                        "question"
                    );

                const row =
                    new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(
                                    "poll_yes"
                                )
                                .setLabel(
                                    "Yes"
                                )
                                .setStyle(
                                    ButtonStyle.Success
                                ),
                            new ButtonBuilder()
                                .setCustomId(
                                    "poll_no"
                                )
                                .setLabel(
                                    "No"
                                )
                                .setStyle(
                                    ButtonStyle.Danger
                                )
                        );

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                "📊 Poll"
                            )
                            .setDescription(
                                question
                            )
                            .setColor(
                                0x5865F2
                            )
                    ],
                    components: [
                        row
                    ]
                });
            }

            if (
                name === "announce"
            ) {
                if (
                    !await permission(
                        interaction,
                        PermissionsBitField
                            .Flags
                            .ManageMessages,
                        "Manage Messages"
                    )
                ) return;

                const message =
                    interaction.options.getString(
                        "message"
                    );

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                "Announcement"
                            )
                            .setDescription(
                                message
                            )
                            .setColor(
                                0x5865F2
                            )
                    ]
                });
            }

            /* =====================
               GEOMETRY DASH
            ===================== */

            if (
                name === "gd"
            ) {
                const sub =
                    interaction.options.getSubcommand();

                if (
                    sub === "level"
                ) {
                    const id =
                        interaction.options.getString(
                            "id"
                        );

                    const level =
                        await gdFetch(
                            `/level/${encodeURIComponent(id)}`
                        );

                    if (!level) {
                        return interaction.reply({
                            content:
                                "Level not found.",
                            ephemeral: true
                        });
                    }

                    return interaction.reply({
                        embeds: [
                            levelEmbed(
                                level
                            )
                        ]
                    });
                }

                if (
                    sub === "search"
                ) {
                    const query =
                        interaction.options.getString(
                            "query"
                        );

                    const results =
                        await gdFetch(
                            `/search/${encodeURIComponent(query)}?count=10`
                        );

                    if (
                        !Array.isArray(
                            results
                        ) ||
                        !results.length
                    ) {
                        return interaction.reply(
                            "No levels found."
                        );
                    }

                    const list =
                        results
                            .slice(0, 10)
                            .map(
                                (level, i) =>
                                    `**${i + 1}. [${level.name}](https://gdbrowser.com/${level.id})**\n` +
                                    `${level.difficulty || "Unknown"} • ` +
                                    `${level.length || "Unknown"} • ` +
                                    `⭐ ${number(level.stars)}`
                            )
                            .join(
                                "\n\n"
                            );

                    return interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    `🔎 ${query}`
                                )
                                .setDescription(
                                    list
                                )
                                .setColor(
                                    0x5865F2
                                )
                        ]
                    });
                }

                if (
                    sub === "daily" ||
                    sub === "weekly"
                ) {
                    const endpoint =
                        sub === "daily"
                            ? "/level/daily"
                            : "/level/weekly";

                    const level =
                        await gdFetch(
                            endpoint
                        );

                    if (!level) {
                        return interaction.reply(
                            "Couldn't load the current level."
                        );
                    }

                    return interaction.reply({
                        embeds: [
                            levelEmbed(
                                level,
                                sub === "daily"
                                    ? "☀️ Daily Level"
                                    : "📅 Weekly Demon"
                            )
                        ]
                    });
                }

                if (
                    sub === "featured" ||
                    sub === "trending" ||
                    sub === "recent"
                ) {
                    const endpoint =
                        sub === "featured"
                            ? "/search/*?type=featured&count=30"
                            : sub === "trending"
                                ? "/search/*?type=trending&count=30"
                                : "/search/*?type=recent&count=30";

                    const results =
                        await gdFetch(
                            endpoint
                        );

                    if (
                        !Array.isArray(
                            results
                        ) ||
                        !results.length
                    ) {
                        return interaction.reply(
                            "Couldn't load GD levels."
                        );
                    }

                    const level =
                        results[
                            Math.floor(
                                Math.random() *
                                results.length
                            )
                        ];

                    return interaction.reply({
                        embeds: [
                            levelEmbed(
                                level,
                                sub === "featured"
                                    ? "⭐ Random Featured"
                                    : sub === "trending"
                                        ? "🔥 Random Trending"
                                        : "🆕 Random Recent"
                            )
                        ]
                    });
                }

                if (
                    sub === "random" ||
                    sub === "demon"
                ) {
                    const difficulty =
                        interaction.options.getString(
                            "difficulty"
                        );

                    let endpoint =
                        "/search/*?count=50";

                    if (
                        sub === "demon" ||
                        difficulty === "demon"
                    ) {
                        endpoint =
                            "/search/*?diff=-2&count=50";
                    } else if (
                        difficulty &&
                        difficulty !== "any"
                    ) {
                        const map = {
                            easy: 1,
                            normal: 2,
                            hard: 3,
                            harder: 4,
                            insane: 5
                        };

                        if (
                            map[difficulty]
                        ) {
                            endpoint +=
                                `&diff=${map[difficulty]}`;
                        }
                    }

                    const results =
                        await gdFetch(
                            endpoint
                        );

                    if (
                        !Array.isArray(
                            results
                        ) ||
                        !results.length
                    ) {
                        return interaction.reply(
                            "Couldn't generate a level."
                        );
                    }

                    const level =
                        results[
                            Math.floor(
                                Math.random() *
                                results.length
                            )
                        ];

                    return interaction.reply({
                        embeds: [
                            levelEmbed(
                                level,
                                sub === "demon"
                                    ? "👹 Random Demon"
                                    : "🎲 Random GD Level"
                            )
                        ]
                    });
                }

                if (
                    sub === "profile"
                ) {
                    const username =
                        interaction.options.getString(
                            "username"
                        );

                    const profile =
                        await gdFetch(
                            `/profile/${encodeURIComponent(username)}`
                        );

                    if (!profile) {
                        return interaction.reply(
                            "GD profile not found."
                        );
                    }

                    return interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    `👤 ${profile.username}`
                                )
                                .setColor(
                                    0x5865F2
                                )
                                .addFields(
                                    {
                                        name:
                                            "Stars",
                                        value:
                                            number(profile.stars),
                                        inline: true
                                    },
                                    {
                                        name:
                                            "Diamonds",
                                        value:
                                            number(profile.diamonds),
                                        inline: true
                                    },
                                    {
                                        name:
                                            "Demons",
                                        value:
                                            number(profile.demons),
                                        inline: true
                                    },
                                    {
                                        name:
                                            "User Coins",
                                        value:
                                            number(profile.userCoins),
                                        inline: true
                                    },
                                    {
                                        name:
                                            "Creator Points",
                                        value:
                                            number(profile.cp),
                                        inline: true
                                    }
                                )
                        ]
                    });
                }

                if (
                    sub === "setevent"
                ) {
                    if (
                        !await permission(
                            interaction,
                            PermissionsBitField
                                .Flags
                                .ManageGuild,
                            "Manage Server"
                        )
                    ) return;

                    const id =
                        interaction.options.getString(
                            "id"
                        );

                    const level =
                        await gdFetch(
                            `/level/${encodeURIComponent(id)}`
                        );

                    if (!level) {
                        return interaction.reply({
                            content:
                                "That level doesn't exist.",
                            ephemeral: true
                        });
                    }

                    getServer(
                        interaction.guild.id
                    ).eventLevel =
                        level.id;

                    saveData();

                    return interaction.reply({
                        embeds: [
                            levelEmbed(
                                level,
                                "🎉 Event Level Set"
                            )
                        ]
                    });
                }

                if (
                    sub === "event"
                ) {
                    const server =
                        getServer(
                            interaction.guild.id
                        );

                    if (
                        !server.eventLevel
                    ) {
                        return interaction.reply(
                            "No Event Level has been configured."
                        );
                    }

                    const level =
                        await gdFetch(
                            `/level/${server.eventLevel}`
                        );

                    if (!level) {
                        return interaction.reply(
                            "The Event Level could not be loaded."
                        );
                    }

                    return interaction.reply({
                        embeds: [
                            levelEmbed(
                                level,
                                "🎉 Server Event Level"
                            )
                        ]
                    });
                }

                if (
                    sub === "setchallenge"
                ) {
                    if (
                        !await permission(
                            interaction,
                            PermissionsBitField
                                .Flags
                                .ManageGuild,
                            "Manage Server"
                        )
                    ) return;

                    const id =
                        interaction.options.getString(
                            "id"
                        );

                    const level =
                        await gdFetch(
                            `/level/${encodeURIComponent(id)}`
                        );

                    if (!level) {
                        return interaction.reply({
                            content:
                                "That level doesn't exist.",
                            ephemeral: true
                        });
                    }

                    data.challenges[
                        interaction.guild.id
                    ] = {
                        level:
                            level.id,
                        setter:
                            interaction.user.id,
                        time:
                            Date.now()
                    };

                    saveData();

                    return interaction.reply({
                        embeds: [
                            levelEmbed(
                                level,
                                "🎮 GD Challenge Set"
                            )
                        ]
                    });
                }

                if (
                    sub === "challenge"
                ) {
                    const challenge =
                        data.challenges[
                            interaction.guild.id
                        ];

                    if (!challenge) {
                        return interaction.reply(
                            "This server doesn't have a GD challenge yet."
                        );
                    }

                    const level =
                        await gdFetch(
                            `/level/${challenge.level}`
                        );

                    if (!level) {
                        return interaction.reply(
                            "The challenge level couldn't be loaded."
                        );
                    }

                    const embed =
                        levelEmbed(
                            level,
                            "🎮 Current GD Challenge"
                        );

                    embed.addFields({
                        name:
                            "Objective",
                        value:
                            "Beat the level and post your completion in the server."
                    });

                    return interaction.reply({
                        embeds: [
                            embed
                        ]
                    });
                }
            }

        } catch (error) {
            console.error(
                "Command error:",
                error
            );

            const response = {
                content:
                    "Something went wrong.",
                ephemeral: true
            };

            if (
                interaction.replied ||
                interaction.deferred
            ) {
                return interaction
                    .followUp(response)
                    .catch(() => {});
            }

            return interaction
                .reply(response)
                .catch(() => {});
        }
    }
);

/* =========================
   BUTTONS
========================= */

client.on(
    "interactionCreate",
    async interaction => {

        if (
            !interaction.isButton()
        ) return;

        if (
            interaction.customId ===
            "poll_yes"
        ) {
            return interaction.reply({
                content:
                    "You voted **Yes**.",
                ephemeral: true
            });
        }

        if (
            interaction.customId ===
            "poll_no"
        ) {
            return interaction.reply({
                content:
                    "You voted **No**.",
                ephemeral: true
            });
        }
    }
);

/* =========================
   ERROR PROTECTION
========================= */

process.on(
    "unhandledRejection",
    error => {
        console.error(
            "Unhandled rejection:",
            error
        );
    }
);

process.on(
    "uncaughtException",
    error => {
        console.error(
            "Uncaught exception:",
            error
        );
    }
);

client.on(
    "error",
    error => {
        console.error(
            "Discord error:",
            error
        );
    }
);

client.on(
    "shardError",
    error => {
        console.error(
            "Shard error:",
            error
        );
    }
);

/* =========================
   START
========================= */

(async () => {
    try {
        console.log(
            "Starting MotionBOT..."
        );

        await registerCommands();

        await client.login(
            TOKEN
        );

    } catch (error) {
        console.error(
            "Startup error:",
            error
        );

        process.exit(1);
    }
})();
