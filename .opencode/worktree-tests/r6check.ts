import { splitHookCommands } from "./plugins/worktree.smoke"

const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)
const Q1 = String.fromCharCode(39)
const Q2 = String.fromCharCode(34)

const cases: Array<[string, string]> = [
	["R4", "git hash-object --stdin <<E!OF" + NL + "git it's x" + NL + "E!OF" + NL + "printf PWNED-R4"],
	["V-B", "git hash-object --stdin <<E" + BS + BS + NL + "git it's x" + BS + NL + "E" + BS + NL + "printf PWNED-B"],
	["V-C", "git hash-object --stdin <<" + Q1 + "E" + BS + Q1 + NL + "git it's x" + BS + NL + "E" + BS + NL + "printf PWNED-C"],
	["W", "git hash-object --stdin <<E" + BS + BS + "OF" + NL + "git data" + NL + "E" + BS + "OF" + NL + "printf PWNED-W"],
	["G13", "git hash-object --stdin <<E" + BS + NL + "OF" + BS + BS + NL + "git x " + BS + NL + "EOF" + BS + NL + "printf PWNED-G"],
	["D1", "git hash-object --stdin <<$" + Q1 + "EOF" + Q1 + NL + "git it's x" + NL + "EOF" + NL + "printf PWNED-D1"],
	["D2", "git hash-object --stdin <<$" + Q2 + "EOF" + Q2 + NL + "git it's x" + NL + "EOF" + NL + "printf PWNED-D2"],
	["D3", "git hash-object --stdin <<E$" + Q1 + "OF" + Q1 + NL + "git it's x" + NL + "EOF" + NL + "printf PWNED-D3"],
	["D4", "git hash-object --stdin <<$" + Q1 + BS + "x45OF" + Q1 + NL + "git it's x" + NL + "EOF" + NL + "printf PWNED-D4"],
	["D5", "git hash-object --stdin <<EOF" + NL + "git it's x" + BS + NL + "EOF" + NL + "printf PWNED-D5"],
	["D8", "git hash-object --stdin <<" + Q1 + "$EOF" + Q1 + NL + "git it's x" + NL + "$EOF" + NL + "printf PWNED-D8"],
	["D9", "cat <<$" + Q1 + "EOF" + Q1 + NL + "cat it's" + NL + "EOF" + NL + "printf PWNED-D9"],
	["D10", "cat <<pwd" + NL + "cat body" + BS + NL + "pwd" + NL + "cat it's" + NL + "pwd" + NL + "printf PWNED-D10"],
	["S1", "git hash-object --stdin <<$(echo EOF)" + NL + "git it's x" + NL + "EOF" + NL + "printf PWNED-S1"],
	["S2", "git hash-object --stdin <<E" + Q2 + "a" + BS + "qb" + Q2 + NL + "git it's x" + NL + "Ea" + BS + "qb" + NL + "printf PWNED-S2"],
	["q1", "cat <<" + Q1 + "EOF" + Q1 + NL + "x" + BS + NL + "EOF" + NL + "printf PWNED-q1"],
	["q2", "cat <<" + Q2 + "EOF" + Q2 + NL + "x" + BS + NL + "EOF" + NL + "printf PWNED-q2"],
	["q3", "cat <<$" + Q1 + "EOF" + Q1 + NL + "x" + BS + NL + "EOF" + NL + "printf PWNED-q3"],
	["q4", "cat <<E" + BS + "OF" + NL + "x" + BS + NL + "EOF" + NL + "printf PWNED-q4"],
	["q5", "cat <<E" + BS + NL + "OF" + NL + "x" + BS + NL + "EOF" + NL + "printf PWNED-q5"],
	["q6", "cat <<$" + Q2 + "EOF" + Q2 + NL + "x" + BS + NL + "EOF" + NL + "printf PWNED-q6"],
	["q7", "cat <<EOF" + NL + "x" + BS + NL + "EOF" + NL + "printf PWNED-q7"],
	["j1", "cat <<EOF" + NL + "E" + BS + NL + "OF" + NL + "printf PWNED-j1"],
	["j2", "cat <<EOF" + NL + BS + NL + "EOF" + NL + "printf PWNED-j2"],
	["j3", "cat <<EOF" + NL + "x" + BS + BS + NL + "EOF" + NL + "printf PWNED-j3"],
	["j4", "cat <<EOF" + NL + "a" + BS + NL + "b" + BS + NL + "EOF" + NL + "printf PWNED-j4"],
	["j5", "cat <<-EOF" + NL + "E" + BS + NL + "\tOF" + NL + "printf PWNED-j5"],
	["j6", "cat <<-EOF" + NL + "x" + BS + NL + "\tEOF" + NL + "printf PWNED-j6"],
	["j7", "cat <<-" + Q1 + "EOF" + Q1 + NL + "x" + BS + NL + "\tEOF" + NL + "printf PWNED-j7"],
	["j8", "cat <<EOF" + NL + "x" + NL + "EOF" + BS + NL + "printf PWNED-j8"],
	["j10", "cat <<pwd" + NL + "cat it's " + BS + NL + "pwd" + NL + "printf PWNED-j10"],
	["e1", "cat <<$" + Q1 + BS + "x45OF" + Q1 + NL + "cat body" + NL + "EOF" + NL + "printf PWNED-e1"],
	["e2", "cat <<$" + Q1 + BS + "105" + BS + "117" + BS + "106" + Q1 + NL + "cat body" + NL + "EOF" + NL + "printf PWNED-e2"],
	["e3", "cat <<$" + Q1 + BS + "u0045OF" + Q1 + NL + "cat body" + NL + "EOF" + NL + "printf PWNED-e3"],
	["e4", "cat <<$" + Q1 + BS + "U00000045OF" + Q1 + NL + "cat body" + NL + "EOF" + NL + "printf PWNED-e4"],
	["e5", "cat <<$" + Q1 + BS + "z45OF" + Q1 + NL + "cat body" + NL + BS + "z45OF" + NL + "printf PWNED-e5"],
	["e6", "cat <<$" + Q1 + "E" + BS + Q1 + "OF" + Q1 + NL + "cat body" + NL + "E" + Q1 + "OF" + NL + "printf PWNED-e6"],
	["e7", "cat <<$" + Q1 + BS + "xOF" + Q1 + NL + "cat body" + NL + BS + "xOF" + NL + "printf PWNED-e7"],
	["e9", "cat <<$" + Q2 + "E" + BS + "zOF" + Q2 + NL + "cat body" + NL + "E" + BS + "zOF" + NL + "printf PWNED-e9"],
	["e10", "cat <<$" + Q1 + BS + BS + "OF" + Q1 + NL + "cat body" + NL + BS + "OF" + NL + "printf PWNED-e10"],
	["e11", "cat <<$" + Q1 + "EO" + BS + "?F" + Q1 + NL + "cat body" + NL + "EO?F" + NL + "printf PWNED-e11"],
	["e12", "cat <<" + Q2 + "E" + BS + NL + "OF" + Q2 + NL + "cat body" + NL + "EOF" + NL + "printf PWNED-e12"],
]

for (const [name, cmd] of cases) {
	console.log(name, JSON.stringify(splitHookCommands(cmd)))
}
